# Web 知识关联

右侧辅助栏打开「知识关联」，展开「反向链接」「标签」或「断链」。反向链接跟随当前工作区的 Markdown 编辑器。点击任一条目会打开源文件并定位到对应行。断链视图区分目标缺失和同名歧义，外部 URL 不列入断链。

保存 Markdown 后，知识关联面板自动刷新。查询首页时，服务器自动补齐一批尚未索引的已保存版本。处理依据为当前文件版本，重启后可继续。首次导入较大的笔记库或需要全面重新解析时，有写入权限的成员仍可使用「更新知识索引」。反向链接、断链、标签及标签引用均提供「加载更多」。

浏览器通过 `GET /api/knowledge/backlinks?path=<workspace-path>` 查询打开的笔记。仍支持以 `fileId` 查询，两者不可同时提供。`GET /api/knowledge/broken?excludeExternal=1` 仅列出缺失和歧义。

`GET /api/knowledge/tags` 与 `GET /api/knowledge/tags/:tagKey` 返回 `nextCursor`。非空时用原查询条件及 `cursor` 获取下一页。游标与工作区、标签和过滤条件关联。
