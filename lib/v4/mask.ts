/**
 * 敏感数据脱敏（考点 4：raw_value 记录与展示脱敏）
 * 手机号保留前 3 后 4；地址保留前 6 字符；姓名保留姓氏；其余截断。
 */

export const maskPhone = (value: string): string => {
  const digits = value.replace(/[^\d-]/g, "");
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  if (!value) return "";
  return `${value.slice(0, 1)}***`;
};

export const maskAddress = (value: string): string => {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= 6) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 6)}******`;
};

export const maskName = (value: string): string => {
  const text = value.trim();
  if (!text) return "";
  return `${text.slice(0, 1)}${"*".repeat(Math.min(Math.max(text.length - 1, 1), 2))}`;
};

const truncate = (value: string, maxLength = 200): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;

export const maskRawValue = (fieldName: string, value: string): string => {
  const raw = String(value ?? "");
  if (fieldName === "receiverPhone") return maskPhone(raw);
  if (fieldName === "receiverAddress") return maskAddress(raw);
  if (fieldName === "receiverName") return maskName(raw);
  return truncate(raw);
};
