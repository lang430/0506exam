/**
 * V4 压测数据一键准备脚本（题面模块一，强制交付物）
 *
 * 功能：
 * 1. 清理上一轮压测数据（SKU_ 前缀主数据 + LT 前缀运单），可重复执行不产生脏数据；
 * 2. 灌入 20,000 条 SKU 主数据（SKU_00001 ~ SKU_20000，含名称/规格/单位）；
 * 3. 灌入压测文件专用解析规则（走 parse_rules 规则引擎，禁止硬编码解析）；
 * 4. 生成 10,000 行压测 Excel：test-data/10000-orders.xlsx，
 *    SKU 从主数据随机抽取，故意混入 120 个非法 SKU（E001）、
 *    30 个非法电话（E003）、20 个非正数量（E004），用于验证错误定位能力。
 *
 * 执行：npm run seed
 * 等价：node --env-file=.env.local --import tsx scripts/seed-data.ts
 * 清理策略：脚本开头的 cleanup 会删除 SKU_ 前缀主数据与 LT 前缀运单；
 *           Outbox/性能日志/错误明细按任务级联，可用 cleanup --deep 清空全部 V4 运行数据。
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import postgres from "postgres";
import ExcelJS from "exceljs";

const SKU_COUNT = 20000;
const ORDER_COUNT = 2000;
const ROWS_PER_ORDER = 5;
const TOTAL_ROWS = ORDER_COUNT * ROWS_PER_ORDER;
const INVALID_SKU_ROWS = 120;
const INVALID_PHONE_ROWS = 30;
const INVALID_QUANTITY_ROWS = 20;

const parseLocalEnv = (): Record<string, string> => {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(
    readFileSync(envPath, { encoding: "utf-8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
};

const envValue = (name: string): string | undefined => process.env[name] || parseLocalEnv()[name];

const databaseUrl = envValue("DATABASE_URL") || envValue("POSTGRES_URL") || envValue("POSTGRES_PRISMA_URL") || envValue("POSTGRES_URL_NON_POOLING");
if (!databaseUrl) {
  console.error("[seed] 缺少数据库连接：请配置 DATABASE_URL 或 POSTGRES_URL（.env.local）");
  process.exit(1);
}

const deepCleanup = process.argv.includes("--deep");
const stores = ["黎明屯店", "湖南仓店", "欢乐牧场店", "黔寨寨鞍山店", "海口龙湖天街店", "尹三顺银泰店", "周配送示范店", "多门店一号店", "多门店二号店", "多门店三号店"];
const surnames = ["张", "王", "李", "赵", "刘", "陈", "杨", "黄", "周", "吴"];
const givenNames = ["伟", "芳", "娜", "磊", "静", "强", "敏", "军", "杰", "霞"];
const cities = ["上海市浦东新区张江路", "北京市海淀区中关村大街", "广州市天河区体育西路", "深圳市南山区科技园路", "杭州市西湖区文三路", "成都市武侯区天府大道"];

const randomItem = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const randomPhone = (): string => `13${Math.floor(Math.random() * 10)}${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

interface OrderFileRow {
  externalCode: string;
  storeName: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  skuCode: string;
  skuName: string;
  quantity: number;
  spec: string;
  remark: string;
}

const buildFileRows = (): OrderFileRow[] => {
  const rows: OrderFileRow[] = [];
  const invalidSkuAt = new Set<number>();
  const invalidPhoneAt = new Set<number>();
  const invalidQuantityAt = new Set<number>();
  while (invalidSkuAt.size < INVALID_SKU_ROWS) invalidSkuAt.add(Math.floor(Math.random() * TOTAL_ROWS));
  while (invalidPhoneAt.size < INVALID_PHONE_ROWS) {
    const candidate = Math.floor(Math.random() * TOTAL_ROWS);
    if (!invalidSkuAt.has(candidate)) invalidPhoneAt.add(candidate);
  }
  while (invalidQuantityAt.size < INVALID_QUANTITY_ROWS) {
    const candidate = Math.floor(Math.random() * TOTAL_ROWS);
    if (!invalidSkuAt.has(candidate) && !invalidPhoneAt.has(candidate)) invalidQuantityAt.add(candidate);
  }
  for (let orderIndex = 0; orderIndex < ORDER_COUNT; orderIndex += 1) {
    const externalCode = `LT-A${String(orderIndex + 1).padStart(5, "0")}`;
    const storeName = randomItem(stores);
    const receiverName = randomItem(surnames) + randomItem(givenNames);
    const receiverPhone = randomPhone();
    const receiverAddress = `${randomItem(cities)}${Math.floor(Math.random() * 900) + 100}号`;
    for (let lineIndex = 0; lineIndex < ROWS_PER_ORDER; lineIndex += 1) {
      const globalIndex = orderIndex * ROWS_PER_ORDER + lineIndex;
      const skuOrdinal = Math.floor(Math.random() * SKU_COUNT) + 1;
      const skuCode = invalidSkuAt.has(globalIndex)
        ? `SKU_BAD_${String(globalIndex).padStart(5, "0")}`
        : `SKU_${String(skuOrdinal).padStart(5, "0")}`;
      rows.push({
        externalCode,
        storeName,
        receiverName,
        receiverPhone: invalidPhoneAt.has(globalIndex) ? "12345" : receiverPhone,
        receiverAddress,
        skuCode,
        skuName: `压测商品 ${skuOrdinal}`,
        quantity: invalidQuantityAt.has(globalIndex) ? 0 : Math.floor(Math.random() * 50) + 1,
        spec: randomItem(["500g", "1kg", "2L", "5L", "12入/箱"]),
        remark: ""
      });
    }
  }
  return rows;
};

const generateExcel = async (rows: OrderFileRow[], outputPath: string): Promise<void> => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("压测运单");
  sheet.columns = [
    { header: "外部编码", key: "externalCode" },
    { header: "收货门店", key: "storeName" },
    { header: "收件人姓名", key: "receiverName" },
    { header: "收件人电话", key: "receiverPhone" },
    { header: "收件人地址", key: "receiverAddress" },
    { header: "SKU物品编码", key: "skuCode" },
    { header: "SKU物品名称", key: "skuName" },
    { header: "SKU发货数量", key: "quantity" },
    { header: "SKU规格型号", key: "spec" },
    { header: "备注", key: "remark" }
  ];
  rows.forEach((row) => sheet.addRow(row));
  await book.xlsx.writeFile(outputPath);
};

const main = async (): Promise<void> => {
  const startedAt = Date.now();
  const sql = postgres(databaseUrl as string, { ssl: "require", max: 1 });

  console.log("[seed] 1/5 清理旧压测数据…");
  await sql`delete from public.imported_orders where external_code like 'LT%'`;
  if (deepCleanup) {
    await sql`delete from public.import_task_errors`;
    await sql`delete from public.batch_performance_log`;
    await sql`delete from public.trace_events`;
    await sql`delete from public.event_outbox`;
    await sql`delete from public.import_task_files`;
    await sql`delete from public.import_task_batches`;
    await sql`delete from public.import_tasks`;
  }
  await sql`delete from public.sku_master where sku_code like 'SKU_%'`;

  console.log(`[seed] 2/5 灌入 ${SKU_COUNT} 条 SKU 主数据（批量 2000/批）…`);
  const skuStartedAt = Date.now();
  const specs = ["500g", "1kg", "2L", "5L", "12入/箱"];
  const units = ["袋", "瓶", "箱", "桶", "盒"];
  for (let start = 1; start <= SKU_COUNT; start += 2000) {
    const chunk = Array.from({ length: Math.min(2000, SKU_COUNT - start + 1) }, (_, offset) => {
      const ordinal = start + offset;
      return {
        sku_code: `SKU_${String(ordinal).padStart(5, "0")}`,
        name: `压测商品 ${ordinal}`,
        spec: specs[ordinal % specs.length],
        unit: units[ordinal % units.length]
      };
    });
    await sql`
      insert into public.sku_master
      ${sql(chunk, "sku_code", "name", "spec", "unit")}
      on conflict (sku_code) do update set name = excluded.name, spec = excluded.spec, unit = excluded.unit
    `;
  }
  console.log(`[seed]    SKU 灌入完成，耗时 ${Date.now() - skuStartedAt}ms`);

  console.log("[seed] 3/5 灌入压测文件解析规则（parse_rules 规则引擎配置）…");
  const rule = {
    id: "rule-loadtest-standard",
    name: "压测标准表：单表头映射",
    mode: "table",
    sheetStrategy: "first",
    headerRow: 1,
    dataStartRow: 2,
    mappings: {
      externalCode: { source: "header", header: "外部编码" },
      storeName: { source: "header", header: "收货门店" },
      receiverName: { source: "header", header: "收件人姓名" },
      receiverPhone: { source: "header", header: "收件人电话" },
      receiverAddress: { source: "header", header: "收件人地址" },
      skuCode: { source: "header", header: "SKU物品编码" },
      skuName: { source: "header", header: "SKU物品名称" },
      quantity: { source: "header", header: "SKU发货数量" },
      spec: { source: "header", header: "SKU规格型号" },
      remark: { source: "header", header: "备注" }
    },
    assumptions: ["压测文件为标准明细表：第 1 行表头，第 2 行起数据，共 10000 行。"]
  };
  await sql`
    insert into public.parse_rules (id, payload)
    values (${rule.id}, ${sql.json(rule)})
    on conflict (id) do update set payload = excluded.payload, updated_at = now()
  `;

  console.log(`[seed] 4/5 生成 ${TOTAL_ROWS} 行压测 Excel（含 ${INVALID_SKU_ROWS} 非法SKU / ${INVALID_PHONE_ROWS} 非法电话 / ${INVALID_QUANTITY_ROWS} 非正数量）…`);
  const rows = buildFileRows();
  mkdirSync(join(process.cwd(), "test-data"), { recursive: true });
  const outputPath = join(process.cwd(), "test-data", "10000-orders.xlsx");
  await generateExcel(rows, outputPath);

  const stats = await sql`select count(*)::int as c from public.sku_master`;
  console.log(`[seed] 5/5 完成。sku_master 现有 ${stats[0]?.c} 条；压测文件：${outputPath}`);
  console.log(`[seed] 压测命令：npm run loadtest（默认上传 test-data/10000-orders.xlsx，规则 ${rule.id}）`);
  console.log(`[seed] 总耗时 ${Date.now() - startedAt}ms`);
  await sql.end();
};

main().catch((error) => {
  console.error("[seed] 失败：", error);
  process.exit(1);
});
