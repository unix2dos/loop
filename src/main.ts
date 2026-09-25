import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { projectRoot } from './storage.ts';
import { NewServer } from './server.ts';
const { values } = parseArgs({ options: {
        workspace: { type: 'string', default: join(projectRoot, 'workspace') },
        'state-dir': { type: 'string', default: join(homedir(), '.loop', process.env.LOOP_PUBLIC === '1' ? 'public-runs' : 'ts-runs') },
        port: { type: 'string', default: '8877' },
    } });
const portText = process.env.PORT || values.port;
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
    throw new Error('invalid PORT');
const host = process.env.LOOP_PUBLIC === '1' ? '0.0.0.0' : '127.0.0.1';
const app = NewServer(values.workspace, values['state-dir']);
app.server.on('error', () => { console.error('Loop 启动失败，请检查端口和工作目录'); process.exitCode = 1; });
app.server.listen(Number(portText), host, () => console.log(`Loop：http://${host}:${portText}\n只读 Markdown 工作区：${app.workspace}\n运行记录：${app.state}`));
