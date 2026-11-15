"""演示数据版本管理。

每个演示版本是独立 schema（demo_v<N>）下的一对样表结构副本
（merchants + settlement_orders），结构与 public 下的原始结算样表相同，
用来在不改动原始样表（补记照常进行）的前提下，按不同商户集中度
复现结算 SQL 的误选计划。

关键语义：
- 构建（建 schema、建表、灌数、建索引、ANALYZE）在单个事务内完成：
  任一步失败整体回滚，不留下半成品，当前默认版本也不变；
- 构建期间旧版本照常可查（新 schema 在发布前对查询不可见）；
- 发布是独立的短事务，由 advisory lock 串行化：version_id 取自序列，
  即提交顺序；若已有更晚提交的版本发布，本版本标记「被取代」并丢弃
  schema——先提交的迟到结果绝不会覆盖后提交版本的发布结果；
- 已发布版本全部保留，新批次可选择任意旧版本；
- 批次启动时把 search_path 钉在所选版本的 schema（见 runner.py），
  四次执行都读该版本，即使随后发布了新版。
"""
from __future__ import annotations

import asyncio
import re
from decimal import Decimal

import asyncpg

MAX_ORDER_COUNT = 100_000  # 订单数上限：10 万
MERCHANT_COUNT = 5000      # 演示表商户数，与样表一致
TOP_MERCHANTS = 100        # 头部商户数（类别 A，即「前 100 家」）
PUBLISH_LOCK_KEY = 20261115  # 发布临界区的 advisory lock 键（任意常量）

REGISTRY_DDL = """
CREATE SEQUENCE IF NOT EXISTS demo_version_seq START 1;
CREATE TABLE IF NOT EXISTS demo_versions (
    version_id   bigint PRIMARY KEY,             -- 取自 demo_version_seq，即提交顺序
    schema_name  text NOT NULL UNIQUE,
    label        text NOT NULL,
    order_count  integer NOT NULL,
    top100_share numeric(5,2) NOT NULL,          -- 前 100 家商户订单占比（%）
    status       text NOT NULL CHECK (status IN ('building', 'published', 'superseded', 'failed')),
    is_current   boolean NOT NULL DEFAULT false,
    error        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);
"""

_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")


def quote_ident(name: str) -> str:
    """校验并引用 schema 标识符（注册表中的名字均由本模块生成，仍做双保险）。"""
    if not _IDENT_RE.match(name):
        raise ValueError(f"非法 schema 标识符: {name!r}")
    return '"' + name + '"'


class VersionManager:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool
        self._tasks: set[asyncio.Task] = set()

    async def setup(self) -> None:
        """建注册表、登记原始样表版本、清理上次中断留下的构建半成品。"""
        async with self._pool.acquire() as conn:
            await conn.execute(REGISTRY_DDL)
            # 原始样表固定为 0 号版本（public schema），永远可选
            await conn.execute(
                """
                INSERT INTO demo_versions
                    (version_id, schema_name, label, order_count, top100_share,
                     status, is_current, published_at)
                VALUES (0, 'public', '原始样表', 1000000, 70.0, 'published', true, now())
                ON CONFLICT (version_id) DO NOTHING
                """
            )
            # 兜底：保证恰好有一个当前默认版本
            await conn.execute(
                """
                UPDATE demo_versions SET is_current = true
                WHERE version_id = 0
                  AND NOT EXISTS (SELECT 1 FROM demo_versions WHERE is_current)
                """
            )
            # 上次服务中断时可能留下 building 状态的行：构建事务已随连接回滚，
            # 或建完未及发布——无论哪种都按失败登记并清掉残留 schema
            stale = await conn.fetch(
                "SELECT version_id, schema_name FROM demo_versions WHERE status = 'building'"
            )
            for row in stale:
                await conn.execute(
                    f"DROP SCHEMA IF EXISTS {quote_ident(row['schema_name'])} CASCADE"
                )
                await conn.execute(
                    """
                    UPDATE demo_versions
                    SET status = 'failed', error = '构建期间服务重启，半成品已清理'
                    WHERE version_id = $1
                    """,
                    row["version_id"],
                )

    async def list_versions(self) -> dict:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM demo_versions ORDER BY version_id DESC"
            )
        versions = [self._to_dict(r) for r in rows]
        current = next((v["version_id"] for v in versions if v["is_current"]), None)
        return {"current_version_id": current, "versions": versions}

    async def resolve(self, version_id: int | None) -> dict | None:
        """批次启动时解析版本；version_id 为 None 时取当前默认版本。

        只返回已发布版本（building/failed/superseded 对查询不可见）。
        """
        async with self._pool.acquire() as conn:
            if version_id is None:
                row = await conn.fetchrow(
                    "SELECT version_id, label, schema_name FROM demo_versions WHERE is_current"
                )
            else:
                row = await conn.fetchrow(
                    """
                    SELECT version_id, label, schema_name FROM demo_versions
                    WHERE version_id = $1 AND status = 'published'
                    """,
                    version_id,
                )
        return dict(row) if row else None

    async def submit(self, order_count: int, top100_share: float) -> dict:
        """登记 building 版本并启动后台构建；version_id 即提交顺序号。"""
        async with self._pool.acquire() as conn:
            vid = await conn.fetchval("SELECT nextval('demo_version_seq')")
            schema = f"demo_v{vid}"
            label = f"演示版 #{vid}"
            await conn.execute(
                """
                INSERT INTO demo_versions
                    (version_id, schema_name, label, order_count, top100_share, status)
                VALUES ($1, $2, $3, $4, $5, 'building')
                """,
                vid, schema, label, order_count, Decimal(str(top100_share)),
            )
        task = asyncio.create_task(
            self._build_and_publish(vid, schema, order_count, top100_share)
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return {
            "version_id": vid,
            "schema_name": schema,
            "label": label,
            "order_count": order_count,
            "top100_share": top100_share,
            "status": "building",
        }

    # ---- 后台构建与发布 ----

    async def _build_and_publish(
        self, vid: int, schema: str, order_count: int, share: float
    ) -> None:
        try:
            await self._build(vid, schema, order_count, share)
        except Exception as exc:
            # 构建事务已整体回滚，库里不留半成品；仅登记失败，当前版本不变
            await self._mark_failed(vid, f"构建失败：{type(exc).__name__}: {exc}")
            return
        try:
            published = await self._publish(vid)
        except Exception as exc:
            # 发布事务异常（已回滚）：清掉已构建的 schema，登记失败，当前版本不变
            await self._drop_schema(schema)
            await self._mark_failed(vid, f"发布失败：{type(exc).__name__}: {exc}")
            return
        if not published:
            # 更晚提交的版本已抢先发布：本版本不得覆盖，丢弃 schema
            await self._drop_schema(schema)

    async def _build(self, vid: int, schema: str, order_count: int, share: float) -> None:
        """单事务构建：建 schema、两张同结构表、灌数、建索引、ANALYZE。

        任一步失败则整个事务回滚，数据库里不会留下半成品。
        """
        top_n = round(order_count * share / 100.0)   # 前 100 家商户的订单数
        rest_n = order_count - top_n                 # 其余商户的订单数
        s = quote_ident(schema)
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(f"CREATE SCHEMA {s}")
                await conn.execute(
                    f"""
                    CREATE TABLE {s}.merchants (
                        merchant_id   integer PRIMARY KEY,
                        merchant_name text        NOT NULL,
                        category      text        NOT NULL,
                        city          text        NOT NULL,
                        created_at    timestamptz NOT NULL DEFAULT now()
                    )
                    """
                )
                await conn.execute(
                    f"""
                    CREATE TABLE {s}.settlement_orders (
                        order_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                        order_no    text          NOT NULL,
                        merchant_id integer       NOT NULL REFERENCES {s}.merchants (merchant_id),
                        amount      numeric(12,2) NOT NULL,
                        fee         numeric(12,2) NOT NULL,
                        status      text          NOT NULL DEFAULT 'SETTLED',
                        settle_date date          NOT NULL,
                        created_at  timestamptz   NOT NULL DEFAULT now()
                    )
                    """
                )
                # 商户与样表一致：5000 家，前 100 家为类别 A
                await conn.execute(
                    f"""
                    INSERT INTO {s}.merchants (merchant_id, merchant_name, category, city)
                    SELECT g,
                           '商户-' || lpad(g::text, 5, '0'),
                           CASE WHEN g <= {TOP_MERCHANTS} THEN 'A'
                                ELSE (ARRAY['B','C','D','E'])[1 + (g % 4)] END,
                           (ARRAY['杭州','上海','北京','深圳','广州','成都','南京','武汉','苏州','西安'])[1 + (g % 10)]
                    FROM generate_series(1, {MERCHANT_COUNT}) AS g
                    """
                )
                # 前 100 家商户（类别 A）的订单，占比 share%
                if top_n:
                    await conn.execute(
                        f"""
                        INSERT INTO {s}.settlement_orders
                            (order_no, merchant_id, amount, fee, status, settle_date)
                        SELECT 'D{vid}-' || lpad(g::text, 10, '0'),
                               1 + (random() * {TOP_MERCHANTS - 1})::int,
                               a.amount,
                               round(a.amount * 0.006, 2),
                               'SETTLED',
                               DATE '2026-08-01' + (random() * 104)::int
                        FROM generate_series(1, $1::int) AS g
                        CROSS JOIN LATERAL
                            (SELECT round((1 + random() * 499)::numeric, 2) AS amount) AS a
                        """,
                        top_n,
                    )
                # 其余商户的订单
                if rest_n:
                    await conn.execute(
                        f"""
                        INSERT INTO {s}.settlement_orders
                            (order_no, merchant_id, amount, fee, status, settle_date)
                        SELECT 'D{vid}-' || lpad((g + $2::int)::text, 10, '0'),
                               {TOP_MERCHANTS + 1} + (random() * {MERCHANT_COUNT - TOP_MERCHANTS - 1})::int,
                               a.amount,
                               round(a.amount * 0.006, 2),
                               'SETTLED',
                               DATE '2026-08-01' + (random() * 104)::int
                        FROM generate_series(1, $1::int) AS g
                        CROSS JOIN LATERAL
                            (SELECT round((1 + random() * 499)::numeric, 2) AS amount) AS a
                        """,
                        rest_n, top_n,
                    )
                await conn.execute(
                    f"CREATE INDEX idx_orders_merchant ON {s}.settlement_orders (merchant_id)"
                )
                await conn.execute(
                    f"CREATE INDEX idx_orders_settle_date ON {s}.settlement_orders (settle_date)"
                )
                await conn.execute(f"ANALYZE {s}.merchants")
                await conn.execute(f"ANALYZE {s}.settlement_orders")

    async def _publish(self, vid: int) -> bool:
        """发布临界区（advisory lock 串行化）。

        若已有更晚提交的版本发布（max(published) > vid），本版本是迟到的
        先提交结果：标记「被取代」，绝不覆盖当前版本；否则发布为新的默认版本。
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                await conn.fetchval("SELECT pg_advisory_xact_lock($1)", PUBLISH_LOCK_KEY)
                max_published = await conn.fetchval(
                    "SELECT max(version_id) FROM demo_versions WHERE status = 'published'"
                )
                if max_published is not None and max_published > vid:
                    await conn.execute(
                        """
                        UPDATE demo_versions
                        SET status = 'superseded', error = $2
                        WHERE version_id = $1 AND status = 'building'
                        """,
                        vid,
                        f"更晚提交的版本 #{max_published} 已抢先发布，本版本未生效",
                    )
                    return False
                await conn.execute(
                    "UPDATE demo_versions SET is_current = false WHERE is_current"
                )
                await conn.execute(
                    """
                    UPDATE demo_versions
                    SET status = 'published', is_current = true, published_at = now()
                    WHERE version_id = $1 AND status = 'building'
                    """,
                    vid,
                )
                return True

    async def _mark_failed(self, vid: int, error: str) -> None:
        try:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE demo_versions SET status = 'failed', error = $2
                    WHERE version_id = $1 AND status = 'building'
                    """,
                    vid, error,
                )
        except Exception:
            pass  # 池不可用时由下次启动的 setup() 兜底清理

    async def _drop_schema(self, schema: str) -> None:
        try:
            async with self._pool.acquire() as conn:
                await conn.execute(f"DROP SCHEMA IF EXISTS {quote_ident(schema)} CASCADE")
        except Exception:
            pass  # 同上，启动清理兜底

    @staticmethod
    def _to_dict(row: asyncpg.Record) -> dict:
        d = dict(row)
        d["top100_share"] = float(d["top100_share"])
        d["created_at"] = d["created_at"].isoformat() if d.get("created_at") else None
        d["published_at"] = d["published_at"].isoformat() if d.get("published_at") else None
        return d
