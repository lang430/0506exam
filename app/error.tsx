"use client";

/** 路由级错误边界：页面组件抛错时显示卡片式错误提示 + 重试 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ minHeight: "60dvh", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ maxWidth: 460, width: "100%", background: "#fff", border: "1px solid #d8eeee", borderRadius: 12, padding: "32px 28px", textAlign: "center", boxShadow: "0 10px 30px rgba(15,198,194,.12)" }}>
        <h1 style={{ fontSize: 17, color: "#1d2129", margin: "0 0 8px" }}>页面加载出错</h1>
        <p style={{ fontSize: 13, color: "#6b7785", margin: "0 0 18px", lineHeight: 1.7 }}>
          数据加载或渲染出现瞬时异常，请重试。
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
  );
}
