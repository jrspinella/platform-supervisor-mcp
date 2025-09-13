import React from "react";

export const MessageBubble: React.FC<{ role: "user" | "assistant"; children: any }> = ({ role, children }) => {
  const cls = "bubble " + (role === "assistant" ? "assistant" : "");
  return <div className={cls}>{children}</div>;
};