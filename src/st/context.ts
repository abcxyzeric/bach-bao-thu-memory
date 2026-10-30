/**
 * Lớp bọc mỏng + kiểu dữ liệu cho getContext() của SillyTavern.
 * Toàn bộ tiện ích mở rộng chỉ tiếp xúc với host thông qua đây, ổn định và tại một điểm duy nhất.
 * Lúc chạy getContext được gắn trên window.SillyTavern (API mở rộng ổn định của ST).
 */

export interface STMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  /** Toàn bộ chính văn các swipe của tin nhắn hiện tại trong ST. Câu trả lời AI một trang thường cũng có swipes[0]. */
  swipes?: string[];
  send_date?: string;
  /** Số trang swipe đang hiển thị hiện tại (khi câu trả lời AI có nhiều trang). Một trang / không có swipe có thể là undefined, xử lý như 0 */
  swipe_id?: number;
  /** Dữ liệu riêng của tin nhắn. Bách Bảo Thư lưu nhãn ẩn, tóm tắt lá, ngoại truyện và tầng thông báo nội bộ tại đây. */
  extra?: Record<string, unknown> & {
    bbs_leaf?: import('@/memory/types').LeafExtra;
    bbs_hidden?: boolean;
    bbs_omit?: boolean;
    bbs_internal_notice?: 'backlog';
  };
}

export interface STEventSource {
  on(event: string, handler: (...args: any[]) => void): void;
  off?(event: string, handler: (...args: any[]) => void): void;
  emit?(event: string, ...args: any[]): Promise<void> | void;
}

export interface STEventTypes {
  USER_MESSAGE_RENDERED: string;
  CHARACTER_MESSAGE_RENDERED: string;
  MESSAGE_SENT: string;
  GENERATION_STARTED: string;
  GENERATION_ENDED: string;
  MESSAGE_SWIPED: string;
  CHAT_CHANGED: string;
  [k: string]: string;
}

/** Thẻ nhân vật (chỉ dùng rất ít trường; avatar là khóa duy nhất ổn định, name có thể trùng tên) */
export interface STCharacter {
  name: string;
  avatar: string;
  [k: string]: unknown;
}

export interface STContext {
  chat: STMessage[];
  chatMetadata: Record<string, unknown>;
  name1: string;
  name2: string;
  /** Toàn bộ thẻ nhân vật đã nạp */
  characters?: STCharacter[];
  /** Chỉ mục của nhân vật hiện tại trong characters (chuỗi/số); khi trò chuyện nhóm thì trống */
  characterId?: string | number;
  /** ID nhóm hiện tại; không phải trò chuyện nhóm thì trống */
  groupId?: string;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  saveMetadataDebounced: () => void;
  saveMetadata: () => Promise<void>;
  saveChat: () => Promise<void>;
  /** Đối tượng cài đặt toàn cục của tiện ích mở rộng (= extension_settings, ghi vào settings.json trên máy chủ, đồng bộ xuyên thiết bị). API ổn định của ST. */
  extensionSettings?: Record<string, unknown>;
  /** Chống rung lưu cài đặt toàn cục (lưu đĩa cùng extensionSettings lên máy chủ). API ổn định của ST. */
  saveSettingsDebounced?: () => void;
  reloadCurrentChat: () => Promise<void>;
  eventSource: STEventSource;
  eventTypes: STEventTypes;
  /** Tiêm gợi ý mở rộng (key, value, position, depth, scan, role, filter). API ổn định của ST. */
  setExtensionPrompt?: (
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number,
    filter?: unknown,
  ) => void;
  /** Thực thi lệnh gạch chéo (như /hide 0-3). API ổn định của ST. */
  executeSlashCommandsWithOptions?: (command: string, options?: Record<string, unknown>) => Promise<unknown>;
  /**
   * Quản lý kết nối: gửi yêu cầu bằng "hồ sơ kết nối đang chọn hiện tại" (đi theo API chính). Nguồn từ extensions/shared.js.
   * sendRequest(profileId, messages, maxTokens, custom, overridePayload):
   *   custom.includePreset=false → không áp preset hoàn thành (chỉ dùng thông tin API của hồ sơ đó);
   *   custom.includeInstruct=false → hồ sơ hoàn thành văn bản cũng bỏ qua khuôn mẫu instruct;
   *   overridePayload có thể nhét các tham số lấy mẫu như temperature (vì không đi qua preset).
   *   Khi extractData=true (mặc định) trả về { content } để lấy văn bản.
   */
  ConnectionManagerRequestService?: {
    sendRequest: (
      profileId: string,
      prompt: Array<{ role: string; content: string }> | string,
      maxTokens: number,
      custom?: {
        stream?: boolean;
        signal?: AbortSignal | null;
        extractData?: boolean;
        includePreset?: boolean;
        includeInstruct?: boolean;
      },
      overridePayload?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  /**
   * Dùng "API chính hiện tại" (cài đặt hoàn thành trò chuyện / hoàn thành văn bản đang dùng trên giao diện chính) gửi hoàn thành một lần. Nguồn từ script.js, API ổn định của ST.
   * Khi prompt truyền mảng tin nhắn thì chỉ gửi các tin nhắn này, không mang lịch sử trò chuyện / thẻ nhân vật; api mặc định = main_api (API chính hiện tại của người dùng).
   * Bên trong đi qua sendOpenAIRequest('quiet', …), quiet cưỡng chế phi luồng, trả về toàn bộ đoạn văn bản sau khi làm sạch.
   */
  generateRaw?: (params: {
    prompt: Array<{ role: string; content: string }> | string;
    api?: string | null;
    systemPrompt?: string;
    responseLength?: number | null;
    prefill?: string;
    jsonSchema?: unknown;
  }) => Promise<string>;
  /** Mở rộng các macro như {{char}}/{{user}}. Khi tóm tắt mang theo mô tả thẻ nhân vật, bên trong trường có thể chứa macro, cần dùng hàm này để khôi phục. API ổn định của ST. */
  substituteParams?: (content: string) => string;
  /**
   * Kích hoạt mục sách thế giới theo văn bản (kích hoạt bằng từ khóa + thường trú constant). API ổn định của ST (world-info.js).
   * chat là mảng văn bản chờ quét (từ cũ đến mới); isDryRun=true chỉ quét không kích hoạt sự kiện tác dụng phụ.
   */
  getWorldInfoPrompt?: (
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData?: Record<string, unknown>,
  ) => Promise<{
    worldInfoBefore?: string;
    worldInfoAfter?: string;
    worldInfoString?: string;
    /** Các mục @độ sâu: {depth, role, entries: string[]}. Rất nhiều mục đèn xanh lam nằm ở đây */
    worldInfoDepth?: Array<{ depth?: number; role?: number; entries?: string[] }>;
    /** Các mục trước/sau ghi chú tác giả (mảng chuỗi content) */
    anBefore?: string[];
    anAfter?: string[];
  }>;
  /** Toàn bộ tên file sách thế giới đã nạp (toàn cục + gắn với nhân vật). API ổn định của ST, dùng cho hộp thả xuống "Loại trừ cả cuốn". */
  getWorldInfoNames?: () => string[];
  /** Token tối đa của ngữ cảnh chính (tham số ngân sách đưa cho getWorldInfoPrompt) */
  maxContext?: number;
  // Tương thích cách đặt tên kiểu cũ
  event_types?: STEventTypes;
  [k: string]: any;
}

interface STGlobal {
  getContext: () => STContext;
}

declare global {
  interface Window {
    SillyTavern?: STGlobal;
  }
}

/** Lấy ngữ cảnh ST; khi chưa sẵn sàng trả về null. */
export function getContext(): STContext | null {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Nối thêm văn bản vào ô nhập chính của ST, không kích hoạt gửi.
 * Phát sự kiện input để đồng bộ chiều cao ô nhập, nút gửi và các trạng thái liên quan đến bản nháp của ST.
 */
export function appendChatInput(text: string): boolean {
  try {
    const value = text.trim();
    const textarea = document.querySelector<HTMLTextAreaElement>('#send_textarea');
    if (!value || !textarea) return false;

    const existing = textarea.value;
    const separator = !existing
      ? ''
      : existing.endsWith('\n\n')
        ? ''
        : existing.endsWith('\n')
          ? '\n'
          : '\n\n';
    textarea.value = `${existing}${separator}${value}`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    requestAnimationFrame(() => {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Khi cập nhật chính văn tin nhắn thì đồng bộ luôn swipe hiện tại.
 *
 * Trong định dạng lưu của ST cả `mes` lẫn `swipes[swipe_id]` đều tồn tại; chỉ sửa `mes` sẽ gây ra việc văn bản
 * trang hiện tại bị tách rời khỏi bản sao lưu swipe. Mọi thao tác ghi trả lại chính văn nội bộ của plugin đều đi qua đây.
 */
export function setMessageText(message: STMessage | undefined, text: string): void {
  if (!message) return;
  message.mes = text;
  if (!Array.isArray(message.swipes)) return;
  const idx = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  if (idx >= 0 && idx < message.swipes.length) message.swipes[idx] = text;
}

/**
 * Lấy doNewChat của ST (getContext không bộc lộ, lấy động từ /script.js).
 * Dùng cho "Tạo cuộc trò chuyện mới kèm dữ liệu": doNewChat({deleteCurrentChat:false}) tạo mới một cuộc trò chuyện trống dưới nhân vật hiện tại và chuyển vào đó.
 * Khi không lấy được (bản cũ / đổi đường dẫn) trả về null, bên gọi dựa vào đó hạ cấp báo lỗi.
 */
export async function getDoNewChat(): Promise<((opts?: { deleteCurrentChat?: boolean }) => Promise<void>) | null> {
  try {
    // Biến giữ đường dẫn, tránh việc Vite/vue-tsc phân tích /script.js như mô-đun cục bộ
    const scriptPath = '/script.js';
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ scriptPath);
    const fn = mod.doNewChat;
    return typeof fn === 'function' ? (fn as (opts?: { deleteCurrentChat?: boolean }) => Promise<void>) : null;
  } catch {
    return null;
  }
}

/** Một mục sách thế giới đã kích hoạt (đối tượng mục do checkWorldInfo trả về; chỉ lấy các trường dùng cho lọc/sắp xếp/ghép nối). */
export interface WorldInfoEntry {
  /** Tên file sách thế giới sở hữu (loại trừ cả cuốn khớp theo trường này) */
  world?: string;
  /** Ghi chú / tiêu đề mục (lọc tên mục khớp theo trường này) */
  comment?: string;
  /** Chính văn của mục */
  content?: string;
  /** Thứ tự chèn (Order). Khi ST ghép prompt các mục cùng vị trí sẽ xếp tăng dần theo nó; mặc định coi là 100 (giá trị mặc định khi ST tạo mục mới) */
  order?: number;
  /** Vị trí chèn: 0 trước nhân vật / 1 sau nhân vật / 2 trước ghi chú tác giả / 3 sau ghi chú tác giả / 4 @độ sâu / 5 EM trên / 6 EM dưới / 7 cổng ra; mặc định coi là 0 */
  position?: number;
  /** Giá trị độ sâu của mục @độ sâu (chỉ tham gia sắp xếp khi position=4; ST mặc định là 4) */
  depth?: number;
  [k: string]: unknown;
}

/** Cấu trúc trả về của checkWorldInfo (chỉ khai báo trường chúng ta cần dùng). */
interface CheckWorldInfoResult {
  /** Toàn bộ các mục đã kích hoạt (đã hoàn tất quét/đệ quy/ngân sách, là tập hợp cuối cùng sẽ đi vào prompt) */
  allActivatedEntries?: Set<WorldInfoEntry> | Map<string, WorldInfoEntry>;
  [k: string]: unknown;
}

type CheckWorldInfoFn = (
  chat: string[],
  maxContext: number,
  isDryRun: boolean,
  globalScanData?: Record<string, unknown>,
) => Promise<CheckWorldInfoResult>;

/**
 * Lấy checkWorldInfo của ST (getContext không bộc lộ, lấy động từ /scripts/world-info.js).
 * Khác với getWorldInfoPrompt: nó trả về **tập hợp đối tượng mục** (kèm world/comment/content),
 * nhờ đó mới lọc theo tên sách thế giới / tên mục được —— còn getWorldInfoPrompt chỉ nhả chuỗi đã ghép xong, mất sạch siêu thông tin.
 * Khi không lấy được (bản cũ / đổi đường dẫn) trả về null, bên gọi dựa vào đó hạ cấp về lại getWorldInfoPrompt (không lọc).
 */
export async function getCheckWorldInfo(): Promise<CheckWorldInfoFn | null> {
  try {
    // Biến giữ đường dẫn, tránh việc Vite/vue-tsc phân tích nó như mô-đun cục bộ
    const wiPath = '/scripts/world-info.js';
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ wiPath);
    const fn = mod.checkWorldInfo;
    return typeof fn === 'function' ? (fn as CheckWorldInfoFn) : null;
  } catch {
    return null;
  }
}

/**
 * Giao diện bộ thực thi của ST-Prompt-Template (plugin khuôn mẫu prompt) gắn trên globalThis (xem exports.ts của nó).
 * Chúng ta chỉ dùng tới prepareContext + evalTemplate: cái trước chuẩn bị xong env có chứa ngữ cảnh biến số / sách thế giới,
 * cái sau chạy EJS trên văn bản có chứa <% %>. Dùng để giúp sách thế giới mà API phụ đọc được nhận về thành phẩm "sau khi thực thi", thay vì nguyên văn.
 * Chỉ khai báo hai phương thức dùng tới; khi chưa cài plugin thì globalThis.EjsTemplate là undefined, bên gọi dựa vào đó hạ cấp.
 */
export interface EjsTemplateApi {
  prepareContext: (context?: Record<string, unknown>, end?: number) => Promise<Record<string, unknown>>;
  evalTemplate: (
    code: string,
    context?: Record<string, unknown> | null,
    options?: Record<string, unknown>,
  ) => Promise<string | null>;
}

/** Lấy bộ thực thi khuôn mẫu do ST-Prompt-Template bộc lộ; khi chưa cài / giao diện không đầy đủ trả về null (bên gọi hạ cấp thành không thực thi EJS). */
export function getEjsTemplate(): EjsTemplateApi | null {
  const api = (globalThis as { EjsTemplate?: Partial<EjsTemplateApi> }).EjsTemplate;
  if (api && typeof api.prepareContext === 'function' && typeof api.evalTemplate === 'function') {
    return api as EjsTemplateApi;
  }
  return null;
}
