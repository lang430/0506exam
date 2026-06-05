module.exports = [
"[externals]/next/dist/compiled/next-server/app-route-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-route-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/@opentelemetry/api [external] (next/dist/compiled/@opentelemetry/api, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/@opentelemetry/api", () => require("next/dist/compiled/@opentelemetry/api"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/shared/lib/no-fallback-error.external.js [external] (next/dist/shared/lib/no-fallback-error.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/shared/lib/no-fallback-error.external.js", () => require("next/dist/shared/lib/no-fallback-error.external.js"));

module.exports = mod;
}),
"[externals]/node:fs/promises [external] (node:fs/promises, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:fs/promises", () => require("node:fs/promises"));

module.exports = mod;
}),
"[externals]/node:path [external] (node:path, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:path", () => require("node:path"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/after-task-async-storage.external.js [external] (next/dist/server/app-render/after-task-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/after-task-async-storage.external.js", () => require("next/dist/server/app-render/after-task-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/os [external] (os, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("os", () => require("os"));

module.exports = mod;
}),
"[externals]/fs [external] (fs, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("fs", () => require("fs"));

module.exports = mod;
}),
"[externals]/net [external] (net, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("net", () => require("net"));

module.exports = mod;
}),
"[externals]/tls [external] (tls, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("tls", () => require("tls"));

module.exports = mod;
}),
"[externals]/crypto [external] (crypto, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("crypto", () => require("crypto"));

module.exports = mod;
}),
"[externals]/stream [external] (stream, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("stream", () => require("stream"));

module.exports = mod;
}),
"[externals]/perf_hooks [external] (perf_hooks, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("perf_hooks", () => require("perf_hooks"));

module.exports = mod;
}),
"[project]/lib/default-rules.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "defaultRules",
    ()=>defaultRules
]);
const defaultRules = [
    {
        id: "table-hunan",
        name: "标准明细表：表头映射 + 单号聚合",
        mode: "table",
        sheetStrategy: "first",
        headerRow: 2,
        dataStartRow: 3,
        mappings: {
            externalCode: {
                source: "header",
                header: "配送单号"
            },
            storeName: {
                source: "header",
                header: "收货机构"
            },
            receiverName: {
                source: "header",
                header: "收货人"
            },
            receiverPhone: {
                source: "header",
                header: "联系电话"
            },
            receiverAddress: {
                source: "header",
                header: "收货地址"
            },
            skuCode: {
                source: "header",
                header: "物品编码*"
            },
            skuName: {
                source: "header",
                header: "物品名称"
            },
            quantity: {
                source: "header",
                header: "应发数量"
            },
            spec: {
                source: "header",
                header: "规格型号"
            },
            remark: {
                source: "header",
                header: "备注"
            }
        }
    },
    {
        id: "tail-info",
        name: "尾部收货信息：跳过头部 + 底部提取",
        mode: "table",
        sheetStrategy: "first",
        headerRow: 4,
        dataStartRow: 5,
        stopWhenContains: "合计",
        mappings: {
            skuCode: {
                source: "index",
                index: 3
            },
            skuName: {
                source: "index",
                index: 4
            },
            quantity: {
                source: "index",
                index: 12
            },
            spec: {
                source: "index",
                index: 6
            }
        },
        tailExtractions: [
            {
                field: "receiverName",
                label: "收货人"
            },
            {
                field: "receiverPhone",
                label: "电话"
            },
            {
                field: "receiverAddress",
                label: "地址"
            },
            {
                field: "storeName",
                label: "收货机构"
            }
        ]
    },
    {
        id: "multi-sheet",
        name: "多 Sheet 同构出库单",
        mode: "table",
        sheetStrategy: "all",
        headerRow: 4,
        dataStartRow: 5,
        stopWhenContains: "合计",
        mappings: {
            storeName: {
                source: "sheet"
            },
            skuCode: {
                source: "header",
                header: "物品编码"
            },
            skuName: {
                source: "header",
                header: "物品名称"
            },
            spec: {
                source: "header",
                header: "规格型号"
            },
            quantity: {
                source: "header",
                header: "出库数量"
            },
            remark: {
                source: "header",
                header: "备注"
            }
        },
        tailExtractions: [
            {
                field: "receiverName",
                label: "收货人"
            },
            {
                field: "receiverPhone",
                label: "电话"
            },
            {
                field: "receiverAddress",
                label: "地址"
            }
        ]
    },
    {
        id: "cards",
        name: "卡片式调拨单：边界 + 内部小表",
        mode: "cards",
        sheetStrategy: "first",
        boundaryPattern: "调拨记录",
        itemHeaderPattern: "物品编码",
        mappings: {
            skuCode: {
                source: "header",
                header: "物品编码"
            },
            skuName: {
                source: "header",
                header: "物品名称"
            },
            spec: {
                source: "header",
                header: "规格型号"
            },
            quantity: {
                source: "header",
                header: "数量"
            },
            remark: {
                source: "header",
                header: "备注"
            }
        },
        tailExtractions: [
            {
                field: "storeName",
                label: "调入门店"
            },
            {
                field: "receiverName",
                label: "收货人"
            },
            {
                field: "receiverPhone",
                label: "电话"
            },
            {
                field: "receiverAddress",
                label: "收货地址"
            }
        ]
    },
    {
        id: "matrix-store",
        name: "门店矩阵：SKU × 门店转置",
        mode: "matrix",
        sheetStrategy: "first",
        headerRow: 1,
        dataStartRow: 2,
        matrixValueStartColumn: 14,
        matrixValueEndColumn: 16,
        mappings: {
            skuName: {
                source: "index",
                index: 3
            },
            skuCode: {
                source: "index",
                index: 5
            },
            spec: {
                source: "index",
                index: 8
            },
            remark: {
                source: "index",
                index: 2
            }
        }
    },
    {
        id: "pdf-text-items",
        name: "PDF 文本表格：明细正则 + 底部收货信息",
        mode: "text",
        sheetStrategy: "first",
        itemPattern: "\\b\\d+\\s+(?<remark>[^\\s]+)\\s+(?<skuCode>[A-Z0-9-]{4,})\\s+(?<skuName>.+?)\\s+(?<spec>\\d[^\\s]*(?:\\s*[^\\s]*?)?)\\s+(?<unit>件|瓶|包|桶)\\s+(?<quantity>\\d+)\\b",
        mappings: {
            externalCode: {
                source: "regex",
                pattern: "单据编号：\\s*([A-Z0-9]+)"
            },
            storeName: {
                source: "regex",
                pattern: "收货机构：\\s*([^\\s]+)"
            },
            receiverName: {
                source: "regex",
                pattern: "收货人：\\s*([^\\s]+)"
            },
            receiverPhone: {
                source: "regex",
                pattern: "收货电话：\\s*([0-9-]+)"
            },
            receiverAddress: {
                source: "regex",
                pattern: "收货地址：\\s*(.+?)\\s+打印次数"
            }
        },
        assumptions: [
            "PDF 文本抽取后，明细行需包含序号、物品类别、编码、名称、规格、单位、数量。",
            "名称和规格之间的边界由规格以数字开头这一特征推断，保存前建议预览确认。"
        ]
    }
];
}),
"[project]/app/api/rules/route.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "DELETE",
    ()=>DELETE,
    "GET",
    ()=>GET,
    "POST",
    ()=>POST,
    "runtime",
    ()=>runtime
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:fs/promises [external] (node:fs/promises, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:path [external] (node:path, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/server.js [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$postgres$2f$src$2f$index$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/postgres/src/index.js [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$default$2d$rules$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/lib/default-rules.ts [app-route] (ecmascript)");
;
;
;
;
;
const runtime = "nodejs";
const filePath = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["join"])(process.cwd(), ".data", "rules.json");
const getSql = ()=>{
    const url = process.env.DATABASE_URL;
    return url ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$postgres$2f$src$2f$index$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["default"])(url, {
        ssl: "require",
        max: 1
    }) : null;
};
const readFileRules = async ()=>{
    try {
        return JSON.parse(await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__["readFile"])(filePath, "utf-8"));
    } catch  {
        await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__["mkdir"])((0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["dirname"])(filePath), {
            recursive: true
        });
        await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__["writeFile"])(filePath, JSON.stringify(__TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$default$2d$rules$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["defaultRules"], null, 2), "utf-8");
        return __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$default$2d$rules$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["defaultRules"];
    }
};
const writeFileRules = async (rules)=>{
    await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__["mkdir"])((0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["dirname"])(filePath), {
        recursive: true
    });
    await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__["writeFile"])(filePath, JSON.stringify(rules, null, 2), "utf-8");
};
const ensureTable = async (sql)=>{
    await sql`create table if not exists parse_rules (
    id text primary key,
    payload jsonb not null,
    updated_at timestamptz default now()
  )`;
};
async function GET() {
    const sql = getSql();
    if (!sql) return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
        rules: await readFileRules(),
        mode: "file"
    });
    await ensureTable(sql);
    const rows = await sql`select payload from parse_rules order by updated_at desc`;
    if (!rows.length) {
        for (const rule of __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$default$2d$rules$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["defaultRules"]){
            await sql`insert into parse_rules (id, payload) values (${rule.id}, ${sql.json(JSON.parse(JSON.stringify(rule)))}) on conflict do nothing`;
        }
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
            rules: __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$default$2d$rules$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["defaultRules"],
            mode: "database"
        });
    }
    return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
        rules: rows.map((row)=>row.payload),
        mode: "database"
    });
}
async function POST(request) {
    const rule = await request.json();
    const sql = getSql();
    if (!sql) {
        const rules = await readFileRules();
        const nextRules = [
            rule,
            ...rules.filter((item)=>item.id !== rule.id)
        ];
        await writeFileRules(nextRules);
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
            rules: nextRules,
            mode: "file"
        });
    }
    await ensureTable(sql);
    await sql`insert into parse_rules (id, payload, updated_at)
    values (${rule.id}, ${sql.json(JSON.parse(JSON.stringify(rule)))}, now())
    on conflict (id) do update set payload = excluded.payload, updated_at = now()`;
    const rows = await sql`select payload from parse_rules order by updated_at desc`;
    return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
        rules: rows.map((row)=>row.payload),
        mode: "database"
    });
}
async function DELETE(request) {
    const { id } = await request.json();
    const sql = getSql();
    if (!sql) {
        const nextRules = (await readFileRules()).filter((rule)=>rule.id !== id);
        await writeFileRules(nextRules);
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
            rules: nextRules,
            mode: "file"
        });
    }
    await ensureTable(sql);
    await sql`delete from parse_rules where id = ${id}`;
    const rows = await sql`select payload from parse_rules order by updated_at desc`;
    return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
        rules: rows.map((row)=>row.payload),
        mode: "database"
    });
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__19skr0m._.js.map