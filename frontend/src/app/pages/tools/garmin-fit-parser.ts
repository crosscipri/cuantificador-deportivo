const FIT_EPOCH_SECONDS = 631065600;

interface FitField { number: number; size: number; baseType: number; }
interface FitDefinition { globalNumber: number; littleEndian: boolean; fields: FitField[]; developerFields: FitField[]; }
interface FitMessage { globalNumber: number; fields: Record<number, unknown>; fileName: string; }

export interface SleepInterval { start: number; end: number; }
export interface HeartRateRow { fitTimestamp: number; heartRate: number; }
export interface HrvRow { fitTimestamp: number; hrvMs: number; }

const BASE_TYPES: Record<number, { name: string; size: number; getter?: string; invalid: number | bigint | null }> = {
  0x00: { name: 'enum', size: 1, getter: 'getUint8', invalid: 0xff },
  0x01: { name: 'sint8', size: 1, getter: 'getInt8', invalid: 0x7f },
  0x02: { name: 'uint8', size: 1, getter: 'getUint8', invalid: 0xff },
  0x03: { name: 'sint16', size: 2, getter: 'getInt16', invalid: 0x7fff },
  0x04: { name: 'uint16', size: 2, getter: 'getUint16', invalid: 0xffff },
  0x05: { name: 'sint32', size: 4, getter: 'getInt32', invalid: 0x7fffffff },
  0x06: { name: 'uint32', size: 4, getter: 'getUint32', invalid: 0xffffffff },
  0x07: { name: 'string', size: 1, invalid: null },
  0x08: { name: 'float32', size: 4, getter: 'getFloat32', invalid: null },
  0x09: { name: 'float64', size: 8, getter: 'getFloat64', invalid: null },
  0x0a: { name: 'uint8z', size: 1, getter: 'getUint8', invalid: 0 },
  0x0b: { name: 'uint16z', size: 2, getter: 'getUint16', invalid: 0 },
  0x0c: { name: 'uint32z', size: 4, getter: 'getUint32', invalid: 0 },
  0x0d: { name: 'byte', size: 1, getter: 'getUint8', invalid: 0xff },
  0x0e: { name: 'sint64', size: 8, getter: 'getBigInt64', invalid: null },
  0x0f: { name: 'uint64', size: 8, getter: 'getBigUint64', invalid: null },
  0x10: { name: 'uint64z', size: 8, getter: 'getBigUint64', invalid: 0n },
};

function decodeField(view: DataView, offset: number, field: FitField, littleEndian: boolean): unknown {
  const base = BASE_TYPES[field.baseType & 0x1f];
  if (!base) return null;
  if (base.name === 'string') {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, field.size);
    const zero = bytes.indexOf(0);
    return new TextDecoder().decode(bytes.slice(0, zero < 0 ? bytes.length : zero));
  }
  const values: unknown[] = [];
  for (let i = 0; i < Math.floor(field.size / base.size); i++) {
    const getter = (view as unknown as Record<string, (...args: unknown[]) => number | bigint>)[base.getter!].bind(view);
    const value = base.size === 1 ? getter(offset + i * base.size) : getter(offset + i * base.size, littleEndian);
    if (base.invalid !== null && value === base.invalid) values.push(null);
    else if (typeof value === 'number' && Number.isNaN(value)) values.push(null);
    else values.push(typeof value === 'bigint' ? Number(value) : value);
  }
  return values.length === 1 ? values[0] : values;
}

export function parseFit(buffer: ArrayBuffer, fileName: string): FitMessage[] {
  const view = new DataView(buffer);
  if (view.byteLength < 12) throw new Error(`${fileName}: archivo demasiado pequeño.`);
  const signature = String.fromCharCode(...[8, 9, 10, 11].map(i => view.getUint8(i)));
  if (signature !== '.FIT') throw new Error(`${fileName}: no parece un FIT válido.`);
  const headerSize = view.getUint8(0);
  const dataEnd = Math.min(headerSize + view.getUint32(4, true), view.byteLength);
  const definitions = new Map<number, FitDefinition>();
  const messages: FitMessage[] = [];
  let position = headerSize;
  let lastTimestamp: number | null = null;

  while (position < dataEnd) {
    const header = view.getUint8(position++);
    if (header & 0x80) {
      const definition = definitions.get((header >> 5) & 0x03);
      if (!definition) throw new Error(`${fileName}: definición FIT ausente.`);
      const fields: Record<number, unknown> = {};
      for (const field of definition.fields) {
        if (field.number !== 253) fields[field.number] = decodeField(view, position, field, definition.littleEndian);
        position += field.size;
      }
      for (const field of definition.developerFields) position += field.size;
      if (lastTimestamp !== null) {
        let timestamp: number = Math.floor(lastTimestamp / 32) * 32 + (header & 0x1f);
        if (timestamp <= lastTimestamp) timestamp += 32;
        fields[253] = lastTimestamp = timestamp;
      }
      messages.push({ globalNumber: definition.globalNumber, fields, fileName });
      continue;
    }
    const localNumber = header & 0x0f;
    if (header & 0x40) {
      const hasDeveloperData = Boolean(header & 0x20);
      position++;
      const littleEndian = view.getUint8(position++) === 0;
      const globalNumber = view.getUint16(position, littleEndian); position += 2;
      const fields: FitField[] = [];
      const fieldCount = view.getUint8(position++);
      for (let i = 0; i < fieldCount; i++, position += 3) fields.push({ number: view.getUint8(position), size: view.getUint8(position + 1), baseType: view.getUint8(position + 2) });
      const developerFields: FitField[] = [];
      if (hasDeveloperData) {
        const count = view.getUint8(position++);
        for (let i = 0; i < count; i++, position += 3) developerFields.push({ number: view.getUint8(position), size: view.getUint8(position + 1), baseType: 0x0d });
      }
      definitions.set(localNumber, { globalNumber, littleEndian, fields, developerFields });
      continue;
    }
    const definition = definitions.get(localNumber);
    if (!definition) throw new Error(`${fileName}: registro sin definición FIT.`);
    const fields: Record<number, unknown> = {};
    for (const field of definition.fields) { fields[field.number] = decodeField(view, position, field, definition.littleEndian); position += field.size; }
    for (const field of definition.developerFields) position += field.size;
    if (Number.isInteger(fields[253])) lastTimestamp = fields[253] as number;
    messages.push({ globalNumber: definition.globalNumber, fields, fileName });
  }
  return messages;
}

export function extractSleepIntervals(messages: FitMessage[]): SleepInterval[] {
  const unique = new Map<string, SleepInterval>();
  for (const m of messages) {
    const start = m.fields[3], end = m.fields[5];
    if (m.globalNumber !== 521 || !Number.isInteger(start) || !Number.isInteger(end)) continue;
    const duration = (end as number) - (start as number);
    if (duration >= 1800 && duration <= 86400) unique.set(`${start}:${end}`, { start: start as number, end: end as number });
  }
  return [...unique.values()].sort((a, b) => b.end - a.end);
}

export function extractHeartRate(messages: FitMessage[]): HeartRateRow[] {
  const rows: HeartRateRow[] = [], anchors = new Map<string, number | null>();
  for (const m of messages) {
    if (m.globalNumber !== 55) continue;
    let anchor = anchors.get(m.fileName) ?? null;
    const full = m.fields[253], short = m.fields[26], hr = m.fields[27];
    if (Number.isInteger(full)) anchor = full as number;
    if (!Number.isInteger(short) || !Number.isInteger(hr) || anchor === null) { anchors.set(m.fileName, anchor); continue; }
    let timestamp = Math.floor(anchor / 65536) * 65536 + (short as number);
    if (timestamp < anchor) timestamp += 65536;
    anchors.set(m.fileName, timestamp);
    if ((hr as number) > 0 && (hr as number) < 255) rows.push({ fitTimestamp: timestamp, heartRate: hr as number });
  }
  return [...new Map(rows.map(r => [`${r.fitTimestamp}:${r.heartRate}`, r])).values()].sort((a, b) => a.fitTimestamp - b.fitTimestamp);
}

export function extractHrv(messages: FitMessage[]): HrvRow[] {
  const rows: HrvRow[] = [];
  for (const m of messages) {
    const timestamp = m.fields[253], raw = m.fields[0];
    if (m.globalNumber !== 371 || !Number.isInteger(timestamp) || !Number.isInteger(raw)) continue;
    const hrvMs = (raw as number) / 128;
    if (hrvMs > 0 && hrvMs < 300) rows.push({ fitTimestamp: timestamp as number, hrvMs });
  }
  return [...new Map(rows.map(r => [String(r.fitTimestamp), r])).values()].sort((a, b) => a.fitTimestamp - b.fitTimestamp);
}

const formatter = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function formatFitTimestamp(timestamp: number): string {
  const parts: Record<string, string> = {};
  formatter.formatToParts(new Date((timestamp + FIT_EPOCH_SECONDS) * 1000)).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}:${parts['second']}`;
}
