# Third-Party Notices

qwen-audio-agent 使用并分发若干开源组件。项目自身使用 Apache License 2.0；
第三方组件仍分别受其原许可证约束。

主要组件包括：

| Component | License | Project |
| --- | --- | --- |
| Electron | MIT | https://github.com/electron/electron |
| React / React DOM | MIT | https://github.com/facebook/react |
| Express | MIT | https://github.com/expressjs/express |
| ws | MIT | https://github.com/websockets/ws |
| Vite | MIT | https://github.com/vitejs/vite |
| react-markdown | MIT | https://github.com/remarkjs/react-markdown |
| remark-gfm | MIT | https://github.com/remarkjs/remark-gfm |
| node-qrcode | MIT | https://github.com/soldair/node-qrcode |
| electron-builder | MIT | https://github.com/electron-userland/electron-builder |
| Agent2Agent Protocol JavaScript SDK | Apache-2.0 | https://github.com/a2aproject/a2a-js |
| Agent Client Protocol TypeScript SDK | Apache-2.0 | https://github.com/agentclientprotocol/typescript-sdk |
| Codex ACP adapter | Apache-2.0 | https://github.com/agentclientprotocol/codex-acp |
| Claude Code ACP adapter | Apache-2.0 | https://github.com/zed-industries/claude-code-acp |
| Model Context Protocol TypeScript SDK | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| Zod | MIT | https://github.com/colinhacks/zod |
| concurrently | MIT | https://github.com/open-cli-tools/concurrently |

完整、可复现的依赖版本记录在 `package-lock.json`。npm 安装保留每个依赖包自带的
许可证文件；Electron 安装包同时保留 Electron/Chromium 自带的许可证与 notices。
发布者在升级或新增依赖时必须检查其许可证兼容性，并同步更新本文件。

可选安装组件（不在框架默认依赖或安装包中）：

| Component | Version | License | Project |
| --- | --- | --- | --- |
| Muse Code SDK | 0.1.1 | MIT | https://github.com/meta-models/muse-code-sdk |

仅显式安装 Muse 后台时下载该 SDK；其版本由后台安装目录声明固定。

## Gateway call turn model

Smart Turn v3.2 CPU (Daily/Pipecat): https://huggingface.co/pipecat-ai/smart-turn-v3.
The gateway uses the ONNX model with ONNX Runtime (MIT) and Transformers.js audio features (Apache-2.0); npm retains their licences.

BSD 2-Clause License

Copyright (c) 2024–2025, Daily

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
