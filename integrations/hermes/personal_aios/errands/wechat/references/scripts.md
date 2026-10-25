# 微信短动作源码索引

本文件由 `skill_view(name="wechat")` 的 `linked_files.references` 列出。Hermes 当前不会在 `linked_files.scripts` 中枚举 `.swift`；不表示脚本缺失。直接用 `skill_view(name="wechat", file_path="scripts/Support.swift")` 读取下面需要的源码，不用 terminal、search_files 或 Mac 去找云端路径。

| 文件 | 作用 |
| --- | --- |
| [install.py](../scripts/install.py) | 无 GUI：按本版源码 key 安装/复用缓存；同版本编译受文件锁保护。 |
| [cache-key.txt](cache-key.txt) | 本版完整源码缓存身份；改源码后用 install.py --print-key 更新。 |
| [Support.swift](../scripts/Support.swift) | 每个入口都要编译的公共支持和系统权限弹窗拒绝。 |
| [activate.swift](../scripts/activate.swift) | 激活微信并返回原前台 PID。 |
| [AX.swift](../scripts/AX.swift) | 仅 ax-read、ax-write 共用的 AX 读取。 |
| [ax-read.swift](../scripts/ax-read.swift) | 只读当前微信 AX 内容。 |
| [ax-write.swift](../scripts/ax-write.swift) | 写入并回读搜索词或草稿。 |
| [click.swift](../scripts/click.swift) | 在微信窗口内点击一次。 |
| [clipboard.swift](../scripts/clipboard.swift) | 保存、恢复或设置剪贴板。 |
| [paste.swift](../scripts/paste.swift) | 通过 System Events 粘贴一次。 |
| [key.swift](../scripts/key.swift) | Cmd-F、Cmd-A、Return、Escape。 |
| [screenshot.swift](../scripts/screenshot.swift) | 截取选定微信窗口。 |
| [restore.swift](../scripts/restore.swift) | 恢复原前台 App。 |
| [wechat-bridge-mac-LICENSE](wechat-bridge-mac-LICENSE) | 社区源码许可与署名。 |

`file_path` 一律相对本技能根，如 `scripts/click.swift` 和 `references/wechat-bridge-mac-LICENSE`。主技能返回的 `skill_dir` 是 Hermes 主机上的真实目录。先读 cache-key.txt 并检查设备库存中的对应缓存，命中时直接运行。只有缓存缺失才用 `owner_mac.put` 按原目录结构传送上述全部源码、install.py 与许可，然后执行 install.py --key。源码已存在，不另写 click/key/paste 代替它。
