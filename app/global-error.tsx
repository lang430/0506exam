"use client";

/** 根级错误边界：任何渲染/运行时崩溃都显示友好重试页，替代浏览器默认错误屏 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: "#f4fbfb", fontFamily: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif' }}>
        <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
          <div style={{ maxWidth: 460, width: "100%", background: "#fff", border: "1px solid #d8eeee", borderRadius: 12, padding: "36px 32px", textAlign: "center", boxShadow: "0 10px 30px rgba(15,198,194,.12)" }}>
            <div style={{ width: 52, height: 52, margin: "0 auto 16px", borderRadius: 12, background: "#fff1f0", border: "1px solid #ffccc7", display: "grid", placeItems: "center", color: "#cf1322", fontSize: 24 }}>!</div>
            <h1 style={{ fontSize: 18, color: "#1d2129", margin: "0 0 8px" }}>页面渲染出错了</h1>
            <p style={{ fontSize: 13, color: "#6b7785", margin: "0 0 20px", lineHeight: 1.7 }}>
              系统已记录该错误（{error.digest ?? "unknown"}）。通常是瞬时故障，请重试；若持续出现，请检查监控看板。
            </p>
            <button
              onClick={() => reset()}
              style={{ background: "#0fc6c2", color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontSize: 14, cursor: "pointer", marginRight: 10 }}
            >
              重试
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{ background: "#fff", color: "#0b6e6e", border: "1px solid #b5e8e8", borderRadius: 8, padding: "10px 22px", fontSize: 14, cursor: "pointer" }}
            >
              刷新页面
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
