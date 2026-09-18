import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import ts from 'typescript';
import { decodeHistory, eventIDPattern, object, readRunFile } from './storage.ts';
// Use the installed TS parser's JSON AST for positions in original text, not reserialized JSON.
export function jsonOffset(raw: string, path: string[]): number {
    JSON.parse(raw);
    const tree = ts.parseJsonText('record.json', raw);
    const statement = tree.statements[0];
    if (!statement || !ts.isExpressionStatement(statement))
        throw new Error('JSON path not found');
    let node: ts.Node = statement.expression;
    for (const segment of path) {
        if (ts.isObjectLiteralExpression(node)) {
            const property = node.properties.find(p => ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name) && p.name.text === segment);
            if (!property || !ts.isPropertyAssignment(property))
                throw new Error('JSON path not found');
            node = property.initializer;
        }
        else if (ts.isArrayLiteralExpression(node) && /^(0|[1-9][0-9]*)$/.test(segment) && Number(segment) < node.elements.length)
            node = node.elements[Number(segment)];
        else
            throw new Error('JSON path not found');
    }
    return node.getStart(tree);
}
export function locateRecord(directory: string, id: string, eventID: string, field: string): {
    path: string;
    line: number;
} {
    if (!eventIDPattern.test(eventID) || field && !/^\/(input|output)(\/|$)/.test(field))
        throw new Error('invalid event or field');
    const segments = field ? field.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    let raw: Buffer;
    try {
        raw = readRunFile(directory, id, 'run.json');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
        const trace = readRunFile(directory, id, 'trace.jsonl').toString();
        let line = 0;
        trace.split('\n').forEach((raw, index) => {
            try {
                const record = object(JSON.parse(raw));
                if (record.id === eventID && ['start', 'finish'].includes(String(record.phase))) {
                    jsonOffset(raw, segments);
                    line = index + 1;
                }
            }
            catch { /* Skip incomplete lines during append. */ }
        });
        if (!line)
            throw new Error('event not yet saved');
        return { path: join(directory, id, 'trace.jsonl'), line };
    }
    const run = decodeHistory(raw, id), index = run.events.findIndex(event => event.id === eventID);
    if (index < 0)
        throw new Error('event not found');
    const value = raw.toString(), offset = jsonOffset(value, ['events', String(index), ...segments]);
    return { path: join(directory, id, 'run.json'), line: value.slice(0, offset).split('\n').length };
}
export async function openRecordEditor(location: {
    path: string;
    line: number;
}): Promise<string> {
    const candidates: [
        string,
        string
    ][] = [
        ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', 'Cursor'],
        ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', 'VS Code'],
        ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(folder => [[join(folder, 'cursor'), 'Cursor'], [join(folder, 'code'), 'VS Code']] as [
            string,
            string
        ][]),
    ];
    const candidate = candidates.find(([path]) => { try {
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    } });
    if (!candidate)
        throw new Error('未找到 Cursor 或 VS Code；请安装编辑器及其 cursor / code 命令');
    await new Promise<void>((resolve, reject) => {
        const child = spawn(candidate[0], ['--goto', `${location.path}:${location.line}`], { stdio: 'ignore', shell: false });
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); if (code === 0)
            resolve();
        else
            reject(new Error('编辑器未能打开记录；请检查本机 cursor / code 命令')); });
    });
    return candidate[1];
}
