// viewer.ts — 常驻"查看器"模式入口。
// 与普通 server 的区别:看板读接口前自动同步磁盘(WORKFLOW_VIEWER_SYNC=1),
// 能看到其他实例(agent 会话)新写入的 run,适合当常驻历史看板用。
// 用法:npm run viewer(或 node dist/viewer.js)
// 注意:静态 import 会被提升到 env 赋值之前执行,必须用动态 import 保证顺序。
process.env.WORKFLOW_VIEWER_SYNC = "1";
await import("./server.js");
