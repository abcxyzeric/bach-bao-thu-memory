import { derivedMeta, memory } from '@/memory/store';
import { getContext } from '@/st/context';
import { PLUGIN_VERSION } from '@/version';
import { watch } from 'vue';
import {
  bumpPublicRevision,
  clonePublic,
  getContextAtFloor,
  getFloor,
  getHistory,
  getInjectedHistory,
  getPublicRevision,
  getSnapshot,
  getVar,
  PUBLIC_API_VERSION,
  query,
} from './query';
import type {
  HistoryOptions,
  PublicCapabilities,
  PublicChangeListener,
  PublicChangeNotice,
  PublicFloor,
  PublicFloorContext,
  PublicHistory,
  PublicInjectedHistory,
  PublicQueryRequest,
  PublicQueryResult,
  PublicSnapshot,
  SnapshotAt,
  SnapshotOptions,
  STBaiBaiBookApi,
} from './types';

export const PUBLIC_READY_EVENT = 'st-baibai-book:ready';
export const PUBLIC_CHANGED_EVENT = 'st-baibai-book:changed';

const capabilities: PublicCapabilities = {
  globalApi: true,
  sharedApiChannels: true,
  slashCommand: false,
  macros: false,
  parameterizedMacros: false,
  events: true,
};

const listeners = new Set<PublicChangeListener>();
let registered = false;
let ready = false;
let changeQueued = false;

function chatId(): string | null {
  return getContext()?.getCurrentChatId?.() ?? null;
}

function notice(type: PublicChangeNotice['type']): PublicChangeNotice {
  return {
    type,
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chatId: chatId(),
    capabilities: clonePublic(capabilities),
  };
}

function emitNotice(type: PublicChangeNotice['type']): void {
  const detail = notice(type);
  for (const listener of listeners) {
    try {
      listener(clonePublic(detail));
    } catch (error) {
      console.warn('[Bách Bảo Thư] Lỗi bất thường ở hàm gọi lại đăng ký API công khai', error);
    }
  }
  const eventName = type === 'ready' ? PUBLIC_READY_EVENT : PUBLIC_CHANGED_EVENT;
  window.dispatchEvent(new CustomEvent(eventName, { detail: clonePublic(detail) }));
}

function queueChangedNotice(): void {
  if (changeQueued) return;
  changeQueued = true;
  queueMicrotask(() => {
    changeQueued = false;
    bumpPublicRevision();
    if (ready) emitNotice('changed');
  });
}

function bindPublicChangeEvents(): void {
  const ctx = getContext();
  const eventSource = ctx?.eventSource;
  const eventTypes = ctx?.eventTypes;
  if (!eventSource || !eventTypes) return;
  const names = new Set([
    eventTypes.CHAT_CHANGED,
    eventTypes.USER_MESSAGE_RENDERED,
    eventTypes.CHARACTER_MESSAGE_RENDERED,
    eventTypes.MESSAGE_SENT,
    eventTypes.MESSAGE_SWIPED,
    eventTypes.MESSAGE_DELETED,
    eventTypes.MESSAGE_EDITED,
    eventTypes.MESSAGE_UPDATED,
  ].filter((name): name is string => typeof name === 'string' && !!name));
  for (const name of names) eventSource.on(name, queueChangedNotice);
}

function createApi(): STBaiBaiBookApi {
  return Object.freeze({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    get capabilities() {
      return clonePublic(capabilities);
    },
    getVar: (path: string, options?: SnapshotOptions) => getVar(path, options),
    getSnapshot: (options?: SnapshotOptions) => getSnapshot(options),
    getHistory: (options?: HistoryOptions) => getHistory(options),
    getInjectedHistory: () => getInjectedHistory(),
    getFloor: (floor: number) => getFloor(floor),
    getContextAtFloor: (options: { floor: number }) => getContextAtFloor(options),
    query: (request: PublicQueryRequest) => query(request),
    subscribe(listener: PublicChangeListener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe listener bắt buộc phải là hàm');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function numericArg(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new TypeError(`${label} bắt buộc phải là số nguyên`);
  return number;
}

function atArg(value: unknown): SnapshotAt | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const at = String(value).trim().toLowerCase();
  if (at !== 'before' && at !== 'after') throw new TypeError('at chỉ có thể là before hoặc after');
  return at;
}

function scalarText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function jsonText(value: unknown): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

function textResult(value: PublicQueryResult): string {
  if (value && typeof value === 'object') {
    if ('historyBefore' in value && 'floorSummary' in value) {
      const context = value as PublicFloorContext;
      return [context.historyBefore.text, context.floorSummary].filter(Boolean).join('\n\n');
    }
    if ('mode' in value && value.mode === 'injection') {
      return (value as PublicInjectedHistory).relativeText;
    }
    if ('nodes' in value && 'text' in value) {
      return (value as PublicHistory | PublicInjectedHistory).text;
    }
    if ('memory' in value && 'body' in value) {
      const floor = value as PublicFloor;
      return floor.memory.summary || floor.body;
    }
  }
  return scalarText(value);
}

function formatResult(value: PublicQueryResult, format: string): string {
  if (format === 'raw') return scalarText(value);
  if (format === 'text') return textResult(value);
  return jsonText(value);
}

function firstUnnamed(value: unknown): string {
  if (Array.isArray(value)) return value.length ? String(value[0]) : '';
  return value === undefined || value === null ? '' : String(value);
}

function normalizeResource(value: unknown): PublicQueryRequest['resource'] {
  const raw = String(value ?? 'snapshot').trim();
  if (!raw) return 'snapshot';
  const normalized = raw.toLowerCase();
  if (normalized === 'itemlog' || normalized === 'item-log') return 'itemLog';
  if (normalized === 'injectedhistory' || normalized === 'injected-history') return 'injectedHistory';
  const resources: PublicQueryRequest['resource'][] = [
    'var', 'vars', 'state', 'protagonist', 'items', 'plans', 'scenes', 'npcs',
    'snapshot', 'history', 'injectedHistory', 'floor', 'context',
  ];
  const matched = resources.find(resource => resource.toLowerCase() === normalized);
  if (!matched) throw new TypeError(`resource không xác định: ${raw}`);
  return matched;
}

async function registerSlashCommand(): Promise<boolean> {
  try {
    const parserPath = '/scripts/slash-commands/SlashCommandParser.js';
    const commandPath = '/scripts/slash-commands/SlashCommand.js';
    const argumentPath = '/scripts/slash-commands/SlashCommandArgument.js';
    const [parserModule, commandModule, argumentModule] = await Promise.all([
      import(/* @vite-ignore */ parserPath),
      import(/* @vite-ignore */ commandPath),
      import(/* @vite-ignore */ argumentPath),
    ]);
    const { SlashCommandParser } = parserModule as {
      SlashCommandParser: { addCommandObject(command: unknown): void };
    };
    const { SlashCommand } = commandModule as {
      SlashCommand: { fromProps(props: Record<string, unknown>): unknown };
    };
    const { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } = argumentModule as {
      ARGUMENT_TYPE: Record<string, string>;
      SlashCommandArgument: { fromProps(props: Record<string, unknown>): unknown };
      SlashCommandNamedArgument: { fromProps(props: Record<string, unknown>): unknown };
    };

    const named = (props: Record<string, unknown>) => SlashCommandNamedArgument.fromProps(props);
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
      name: 'bbs-get',
      callback: (args: Record<string, unknown>, unnamed: unknown): string => {
        const namedResource = String(args.resource ?? '').trim();
        const resource = normalizeResource(namedResource || firstUnnamed(unnamed));
        const request: PublicQueryRequest = {
          resource,
          path: args.path === undefined ? undefined : String(args.path),
          floor: numericArg(args.floor, 'floor'),
          at: atArg(args.at),
          before: numericArg(args.before, 'before'),
        };
        const format = String(args.format ?? 'json').trim().toLowerCase();
        if (!['json', 'raw', 'text'].includes(format)) {
          throw new TypeError('format chỉ có thể là json, raw hoặc text');
        }
        return formatResult(query(request), format);
      },
      namedArgumentList: [
        named({
          name: 'resource',
          description: 'Tài nguyên cần đọc',
          typeList: [ARGUMENT_TYPE.STRING],
          enumList: ['var', 'vars', 'state', 'protagonist', 'items', 'plans', 'scenes', 'npcs', 'itemLog', 'snapshot', 'history', 'injectedHistory', 'floor', 'context'],
        }),
        named({
          name: 'path',
          description: 'Đường dẫn biến số, ví dụ Quan_hệ.Alice.Hảo_cảm hoặc Đội_hình[0].hp',
          typeList: [ARGUMENT_TYPE.STRING],
        }),
        named({
          name: 'floor',
          description: 'mesid cơ số 0 của ST',
          typeList: [ARGUMENT_TYPE.NUMBER],
        }),
        named({
          name: 'at',
          description: 'Ảnh chụp nằm trước hay sau tầng mục tiêu',
          typeList: [ARGUMENT_TYPE.STRING],
          defaultValue: 'after',
          enumList: ['before', 'after'],
        }),
        named({
          name: 'before',
          description: 'Tầng lầu cắt cốt truyện lịch sử, không bao gồm tầng đó',
          typeList: [ARGUMENT_TYPE.NUMBER],
        }),
        named({
          name: 'format',
          description: 'Định dạng trả về',
          typeList: [ARGUMENT_TYPE.STRING],
          defaultValue: 'json',
          enumList: ['json', 'raw', 'text'],
        }),
      ],
      unnamedArgumentList: [
        SlashCommandArgument.fromProps({
          description: 'Tên tài nguyên tùy chọn, mặc định là snapshot',
          typeList: [ARGUMENT_TYPE.STRING],
          enumList: ['var', 'vars', 'state', 'protagonist', 'items', 'plans', 'scenes', 'npcs', 'itemLog', 'snapshot', 'history', 'injectedHistory', 'floor', 'context'],
        }),
      ],
      helpString: `
        <div>Đọc dữ liệu trí nhớ chỉ đọc của Bách Bảo Thư và truyền kết quả vào đường ống STscript.</div>
        <div><code>/bbs-get resource=var path="Quan_hệ.Alice.Hảo_cảm" floor=42 at=after format=raw</code></div>
        <div><code>/bbs-get resource=context floor=42 format=json</code></div>
      `,
      returns: ARGUMENT_TYPE.STRING,
    }));
    return true;
  } catch (error) {
    console.warn('[Bách Bảo Thư] Đăng ký /bbs-get thất bại', error);
    return false;
  }
}

function macroSafe(read: () => unknown): string {
  try {
    return scalarText(read());
  } catch (error) {
    console.warn('[Bách Bảo Thư] Đọc macro công khai thất bại', error);
    return '';
  }
}

function macroSnapshot(floor?: string, at?: string): PublicSnapshot {
  return getSnapshot({
    floor: numericArg(floor, 'floor'),
    at: atArg(at),
  });
}

async function registerMacros(): Promise<{ macros: boolean; parameterized: boolean }> {
  try {
    const powerUserPath = '/scripts/power-user.js';
    const powerUserModule = await import(/* @vite-ignore */ powerUserPath) as {
      power_user?: { experimental_macro_engine?: boolean };
    };
    if (powerUserModule.power_user?.experimental_macro_engine) {
      const macroSystemPath = '/scripts/macros/macro-system.js';
      const macroModule = await import(/* @vite-ignore */ macroSystemPath) as {
        macros: {
          register(name: string, options: Record<string, unknown>): unknown;
        };
        MacroCategory?: { CHAT?: string; VARIABLE?: string };
      };
      const categoryChat = macroModule.MacroCategory?.CHAT ?? 'chat';
      const categoryVariable = macroModule.MacroCategory?.VARIABLE ?? 'variable';
      const optionalFloor = {
        name: 'floor',
        optional: true,
        type: 'integer',
        sampleValue: '42',
        description: 'mesid cơ số 0 của ST; khi lược bỏ là cuối cuộc trò chuyện hiện tại.',
      };
      const optionalAt = {
        name: 'at',
        optional: true,
        defaultValue: 'after',
        type: 'string',
        sampleValue: 'after',
        description: 'before không bao gồm tầng mục tiêu, after bao gồm tầng mục tiêu.',
      };
      const definitions: Array<[string, Record<string, unknown>]> = [
        ['bbsVars', {
          category: categoryVariable,
          description: 'Trả về JSON biến tùy chỉnh hiện tại của Bách Bảo Thư.',
          handler: () => macroSafe(() => getSnapshot().vars),
        }],
        ['bbsState', {
          category: categoryChat,
          description: 'Trả về JSON trạng thái thời gian và địa điểm hiện tại của Bách Bảo Thư.',
          handler: () => macroSafe(() => getSnapshot().state),
        }],
        ['bbsSnapshot', {
          category: categoryChat,
          unnamedArgs: [optionalFloor, optionalAt],
          description: 'Trả về JSON ảnh chụp trạng thái đầy đủ hiện tại hoặc tại tầng chỉ định của Bách Bảo Thư.',
          exampleUsage: ['{{bbsSnapshot}}', '{{bbsSnapshot::42::after}}'],
          handler: ({ unnamedArgs: [floor, at] }: { unnamedArgs: string[] }) =>
            macroSafe(() => macroSnapshot(floor, at)),
        }],
        ['bbsHistory', {
          category: categoryChat,
          unnamedArgs: [{
            name: 'before',
            optional: true,
            type: 'integer',
            sampleValue: '42',
            description: 'Chỉ trả về cốt truyện lịch sử có mesid nhỏ hơn giá trị này.',
          }],
          description: 'Trả về văn bản cốt truyện lịch sử đã nén kèm thời gian tương đối của Bách Bảo Thư.',
          exampleUsage: ['{{bbsHistory}}', '{{bbsHistory::42}}'],
          handler: ({ unnamedArgs: [before] }: { unnamedArgs: string[] }) =>
            macroSafe(() => getHistory({ before: numericArg(before, 'before') }).relativeText),
        }],
        ['bbsInjectedHistory', {
          category: categoryChat,
          description: 'Trả về văn bản cốt truyện lịch sử giống với việc tiêm trí nhớ bình thường và đã bỏ qua cửa sổ trượt.',
          exampleUsage: ['{{bbsInjectedHistory}}'],
          handler: () => macroSafe(() => getInjectedHistory().relativeText),
        }],
        ['bbsVar', {
          category: categoryVariable,
          unnamedArgs: [{
            name: 'path',
            type: 'string',
            sampleValue: 'Quan_hệ.Alice.Hảo_cảm',
            description: 'Đường dẫn biến số bằng dấu chấm và chỉ mục mảng.',
          }, optionalFloor, optionalAt],
          description: 'Trả về giá trị biến tại đường dẫn chỉ định của Bách Bảo Thư.',
          exampleUsage: ['{{bbsVar::Quan_hệ.Alice.Hảo_cảm}}', '{{bbsVar::Đội_hình[0].hp::42::after}}'],
          handler: ({ unnamedArgs: [path, floor, at] }: { unnamedArgs: string[] }) =>
            macroSafe(() => getVar(path, {
              floor: numericArg(floor, 'floor'),
              at: atArg(at),
            })),
        }],
        ['bbsFloor', {
          category: categoryChat,
          unnamedArgs: [{
            name: 'floor',
            type: 'integer',
            sampleValue: '42',
            description: 'mesid cơ số 0 của ST.',
          }],
          description: 'Trả về JSON chính văn và tóm tắt lá của tầng chỉ định.',
          exampleUsage: ['{{bbsFloor::42}}'],
          handler: ({ unnamedArgs: [floor] }: { unnamedArgs: string[] }) =>
            macroSafe(() => getFloor(numericArg(floor, 'floor')!)),
        }],
      ];
      const results = definitions.map(([name, options]) => macroModule.macros.register(name, options));
      return {
        macros: results.every(Boolean),
        parameterized: results.every(Boolean),
      };
    }

    const legacyMacroPath = '/scripts/macros.js';
    const legacyModule = await import(/* @vite-ignore */ legacyMacroPath) as {
      MacrosParser: {
        registerMacro(name: string, value: () => string, description?: string): void;
      };
    };
    const stableMacros: Array<[string, () => string, string]> = [
      ['bbsVars', () => macroSafe(() => getSnapshot().vars), 'Trả về JSON biến tùy chỉnh hiện tại của Bách Bảo Thư.'],
      ['bbsState', () => macroSafe(() => getSnapshot().state), 'Trả về JSON trạng thái hiện tại của Bách Bảo Thư.'],
      ['bbsSnapshot', () => macroSafe(() => getSnapshot()), 'Trả về JSON ảnh chụp trạng thái đầy đủ hiện tại của Bách Bảo Thư.'],
      ['bbsHistory', () => macroSafe(() => getHistory().relativeText), 'Trả về văn bản cốt truyện lịch sử đã nén kèm thời gian tương đối của Bách Bảo Thư.'],
      ['bbsInjectedHistory', () => macroSafe(() => getInjectedHistory().relativeText), 'Trả về văn bản cốt truyện lịch sử giống với việc tiêm trí nhớ bình thường và đã bỏ qua cửa sổ trượt.'],
    ];
    for (const [name, handler, description] of stableMacros) {
      legacyModule.MacrosParser.registerMacro(name, handler, description);
    }
    return { macros: true, parameterized: false };
  } catch (error) {
    console.warn('[Bách Bảo Thư] Đăng ký macro công khai thất bại', error);
    return { macros: false, parameterized: false };
  }
}

export async function registerPublicInterface(): Promise<void> {
  if (registered) return;
  registered = true;

  bumpPublicRevision();
  const api = createApi();
  (globalThis as typeof globalThis & { STBaiBaiBook?: STBaiBaiBookApi }).STBaiBaiBook = api;

  watch(
    [() => derivedMeta.rev, () => memory.summaries],
    queueChangedNotice,
    { deep: true },
  );
  bindPublicChangeEvents();

  const [slashAvailable, macroSupport] = await Promise.all([
    registerSlashCommand(),
    registerMacros(),
  ]);
  capabilities.slashCommand = slashAvailable;
  capabilities.macros = macroSupport.macros;
  capabilities.parameterizedMacros = macroSupport.parameterized;

  ready = true;
  emitNotice('ready');
  console.log('[Bách Bảo Thư] Giao diện chỉ đọc công khai đã sẵn sàng', clonePublic(capabilities));
}
