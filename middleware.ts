// =============================================================
// V2 项目（0506exam.vercel.app）根目录 middleware.ts
// 作用：对正式契约 /api/v1/* 强制 Bearer 鉴权，
//       杜绝 V3 → V2 裸奔（满足考点5 鉴权红线）。
// 部署位置：放到 V2 项目根目录，与 package.json 同级。
// =============================================================
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 与 V3 的 V2_API_TOKEN 保持完全一致的共享密钥。
// 在 V2 项目 Vercel 环境变量中配置：V2_API_TOKEN=<共享密钥>
const EXPECTED_TOKEN = process.env.V2_API_TOKEN;

export function middleware(request: NextRequest) {
  // 若 V2 未配置令牌，则 fail-closed：拒绝一切访问，避免误开裸奔。
  if (!EXPECTED_TOKEN) {
    return NextResponse.json(
      { error: "unauthorized", message: "V2_API_TOKEN 未配置，拒绝访问" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  const valid =
    scheme.toLowerCase() === "bearer" &&
    Boolean(token) &&
    token === EXPECTED_TOKEN;

  if (valid) {
    return NextResponse.next();
  }

  return NextResponse.json(
    { error: "unauthorized", message: "缺少或无效的 Bearer Token" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
  );
}

export const config = {
  // 仅保护正式契约接口。
  // 如需同时保护历史 /api/orders，可改为：
  //   matcher: ["/api/v1/:path*", "/api/orders/:path*"]
  matcher: ["/api/v1/:path*"]
};
