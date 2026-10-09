# 插件示例

这里是**命令型工具插件**的示例,演示 `plugin.json` 清单格式。它们**不会自动生效** ——
应用默认从 `插件目录` 加载(见下),把需要的插件文件夹拷进去再「重新加载」即可。

## 安装

1. 打开设置(聊天面板右上角齿轮)→「插件」标签页 →「打开插件目录」。
2. 把 `echo/` 整个文件夹拷进该目录。
3. 回到面板点「重新加载」,或重启应用。
4. 之后模型就能调用 `echo` 工具了。

插件目录默认是 `<userData>/plugins`,可用环境变量 `BROWSER_AGENT_PLUGINS_DIR` 覆盖。

## plugin.json 格式

```json
{
  "name": "插件名(展示用)",
  "tools": [
    {
      "name": "工具名(模型调用时用,不能与内置工具重名)",
      "description": "给模型看的说明,写清楚什么时候用、参数含义",
      "parameters": { "type": "object", "properties": { "...": {} }, "required": [] },
      "command": "python3",
      "args": ["script.py"],
      "input": "stdin",
      "timeoutMs": 30000
    }
  ]
}
```

- `parameters`:JSON Schema,原样作为 function calling 的参数定义。
- `command` + `args`:在**插件目录**里执行的命令。
- `input`:`stdin`(默认)把入参 JSON 写进标准输入;`arg` 作为最后一个命令行参数传入。
- 约定:**stdout 作为工具结果回给模型**,非 0 退出码按失败处理(stderr 作错误说明)。

## ⚠️ 安全

命令型工具会在**本机执行清单里声明的任意命令**,信任级别等同于安装一个本地程序。
只放你信任的插件;目录默认空、不联网、不自动安装。
