import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Growth } from '../shared/types';

/** A file name made from a child's name. */
export function fileSafe(name: string): string { return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '子ども'; }

const cell = (value: number | null) => value === null ? '' : String(value);
/** A child's growth records as CSV, oldest first, one row per month (Codomon dates each record the 1st of its month). The BOM lets Excel read the Japanese header. */
export function growthCsv(records: Growth[]): string {
  const rows = [...records].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map(g => [g.date.slice(0, 7), cell(g.height), cell(g.weight), cell(g.chest), cell(g.head)].join(','));
  return `﻿月,身長（cm）,体重（kg）,胸囲（cm）,頭囲（cm）\n${rows.map(r => `${r}\n`).join('')}`;
}
/** Writes `成長記録/<child>.csv` in the archive for each child, replacing the previous file whole. */
export async function writeGrowthFiles(saveRoot: string, records: Growth[], children: Iterable<string>): Promise<void> {
  for (const child of children) {
    const file = join(saveRoot, '成長記録', `${fileSafe(child)}.csv`), temp = `${file}.${process.pid}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, growthCsv(records.filter(g => g.child === child)));
    await rename(temp, file);
  }
}
