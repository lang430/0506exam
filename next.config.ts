import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // V4：服务端文件解析库不进入 webpack 打包，直接以 Node 原生方式加载
  serverExternalPackages: ["pdfjs-dist", "@e965/xlsx", "mammoth", "exceljs", "postgres"]
};

export default nextConfig;
