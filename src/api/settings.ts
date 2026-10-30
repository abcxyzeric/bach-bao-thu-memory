import { getContext } from '@/st/context';
import { normalizeTemplate, type VarTemplate } from '@/memory/types';
import { reactive, watch } from 'vue';
import { DEFAULT_RECALL_INJECTION_DEPTH, normalizeRecallInjectionDepth } from '@/memory/vector/depth';

/**
 * Cài đặt API phụ (toàn cục, xuyên suốt các cuộc trò chuyện). Lưu vào extension_settings của ST (→ settings.json trên máy chủ),
 * nhờ đó đồng bộ xuyên thiết bị: mở cùng một tài khoản ST trên điện thoại / đầu bên kia mạng LAN là thấy ngay cùng một bản cài đặt.
 * (Phiên bản cũ từng lưu ở localStorage của trình duyệt, chỉ có hiệu lực trên máy cục bộ; xem phần di chuyển một lần ở hydrateSettings.)
 * Có thể cấu hình nhiều kênh; hai loại tác vụ tóm tắt mỗi loại chỉ định một kênh: summary=tóm tắt, resummary=tổng kết.
 */

export interface ApiChannel {
  id: string;
  /** Tên hiển thị */
  name: string;
  /** Base url tương thích OpenAI, như https://api.openai.com/v1 */
  url: string;
  /** Khóa API */
  key: string;
  /** Tên mô hình */
  model: string;
  /** Nhiệt độ lấy mẫu */
  temperature: number;
  /** Token đầu ra tối đa */
  maxTokens: number;
  /** Giới hạn thời gian một yêu cầu đơn lẻ (giây). Quá thời gian sẽ chủ động ngắt; mỗi kênh cấu hình độc lập, mặc định 180 giây. */
  timeoutSec: number;
  /** Truyền tải dạng luồng (stream, mặc định tắt); sau khi bật sẽ ghép tăng thêm theo SSE */
  stream: boolean;
  /** Tham số loại trừ: các tên trường này sẽ bị xóa khỏi body khi xây dựng thân yêu cầu,
   *  dùng để tránh báo lỗi ở các điểm cuối tương thích không chấp nhận một số tham số (như temperature/max_tokens). */
  excludeParams: string[];
  /**
   * Cường độ suy nghĩ (reasoning_effort của mô hình suy luận). Chuỗi rỗng = auto = không gửi tham số này (mặc định, các kênh cũ mang giá trị này).
   *
   * Giá trị lấy vào không kiểm tra danh sách trắng, gửi nguyên bản cho điểm cuối: từ vựng của các bên không thống nhất (minimal/low/medium/high/xhigh của OpenAI,
   * max/none của một số trạm trung chuyển……), trạm trung chuyển hiểu rõ hơn chúng ta về việc mô hình của họ nhận giá trị gì, kiểm tra chỉ gây chặn nhầm.
   *
   * Khi khác rỗng toàn bộ yêu cầu đổi sang đi qua nguồn custom (xem buildRequestBody của api/client.ts):
   * Proxy ST đối với reasoning_effort của nguồn openai có **danh sách trắng tên mô hình** (OPENAI_REASONING_EFFORT_MODELS
   * trong src/constants.js, chỉ khớp chính xác nhóm o1/o3/gpt-5), tên mô hình không khớp là **âm thầm vứt bỏ mà vẫn trả về 200 như thường** ——
   * người dùng đặt nhưng hoàn toàn không có tác dụng mà cũng không nhìn ra. custom_include_body của nguồn custom là gộp thuần túy, không qua danh sách trắng.
   *
   * Xuyên plugin: dùng chung cùng một danh sách kênh (baibai_api_channels) với Bách Bảo Hội / Bách Bảo Nghiên, tên trường của cả ba bên nhất quán.
   */
  reasoningEffort: string;
}

export type TaskType = 'summary' | 'resummary';

/** Prompt tùy chỉnh: chuỗi rỗng biểu thị tiếp tục dùng khuôn mẫu tích hợp sẵn trong prompts.ts, khác rỗng thì ghi đè tổng thể khuôn mẫu của tác vụ đó. */
export interface CustomPrompts {
  summary: string;
  /** Tổng kết thông thường (lá L0 → L1): nén nhiều tóm tắt tầng lầu thành một tổng kết L1. */
  resummary: string;
  /** Tổng kết lần hai (L1+ → tầng cao hơn): nén nhiều bản tổng kết thêm một tầng nữa, số chữ nới lỏng động theo quy mô đầu vào để ít mất thông tin hơn. */
  resummary2: string;
  /** Prompt vượt giới hạn: đính kèm trong yêu cầu tóm tắt / tổng kết; chuỗi rỗng = không đính kèm. */
  jailbreak: string;
  /** Prompt cố định (thẻ thời gian): tiêm vào mô hình **đối thoại chính**, yêu cầu trước và sau mỗi chính văn xuất thẻ thời gian; trống = dùng mặc định tích hợp sẵn. */
  timeTag: string;
}

/**
 * Cấu hình điểm cuối của một vai trò vector đơn lẻ (phẳng: tự mang địa chỉ + khóa + mô hình, không còn trung chuyển qua "kênh").
 * embedding là mốc chuẩn bắt buộc điền; url của rerank/queryRewrite để trống = tái sử dụng tổng thể điểm cuối của embedding.
 */
export interface VectorEndpoint {
  /** Base url tương thích OpenAI (như https://api.openai.com/v1); rerank/query để trống = tái sử dụng embedding */
  url: string;
  /** Khóa API */
  key: string;
  /** Tên mô hình */
  model: string;
  /** Giới hạn thời gian một yêu cầu đơn lẻ (giây). Quá thời gian là ngắt ngay yêu cầu lần đó; mặc định của mỗi vai trò khác nhau (xem defaults), không lùi về theo việc tái sử dụng địa chỉ. */
  timeoutSec: number;
  /** Số lần tự động thử lại khi thất bại: chỉ quá thời gian / lỗi mạng bất thường / máy chủ 5xx / giới hạn tần suất 429 mới thử lại; 4xx không thử lại. Số nguyên không âm. */
  retries: number;
}

/**
 * Tham số truy xuất. Đường ống truy xuất:
 *  ① Tất cả các chỉ mục vector mỗi cái tính một lần độ tương đồng embedding, **thuần túy sắp xếp theo điểm lấy N mục đầu (rerankCandidates) đưa vào rerank** ——
 *     bước này không áp ngưỡng embedding, cho dù N mục đầu toàn là điểm thấp (0.4/0.3…) cũng vẫn vào ứng viên như thường; ngưỡng chỉ dùng cho việc xét duyệt vào mức tóm tắt ở bước ②.
 *  ② Sau khi rerank chấm điểm thì chia làm hai mức:
 *     · Mức toàn văn = điểm rerank ≥ rerankThreshold, lấy fullTextCount mục đầu (gửi nguyên văn toàn bộ);
 *     · Mức tóm tắt = điểm rerank < rerankThreshold nhưng điểm embedding ≥ embeddingThreshold (gửi tóm tắt lá);
 *  ③ Số lượng mục truy xuất cuối cùng ≤ finalRecallCount (trần giới hạn): đặt mức toàn văn trước, chưa đủ mới dùng mức tóm tắt bù vào, bù không đầy cũng không sao.
 */
export interface VectorRecallSettings {
  /** Độ sâu tiêm nội dung truy xuất: D0 bám sát đầu vào mới nhất nhất, con số càng lớn càng nằm về phía trước. */
  injectionDepth: number;
  /** Số lượng ứng viên đưa vào rerank: thuần túy lấy top-N theo độ tương đồng embedding (không áp ngưỡng lọc) */
  rerankCandidates: number;
  /** Ngưỡng độ tương đồng embedding: chỉ dùng làm ngưỡng xét duyệt mức tóm tắt ở bước ② (thấp hơn mức này thì ngay cả tóm tắt cũng không truy xuất); không ảnh hưởng việc lấy ứng viên ở bước ① */
  embeddingThreshold: number;
  /** Ngưỡng điểm rerank: ≥ đi vào mức toàn văn, < lùi về mức tóm tắt */
  rerankThreshold: number;
  /** Số lượng toàn văn truy xuất: mức toàn văn lấy N mục đầu (gửi nguyên văn) */
  fullTextCount: number;
  /** Số lượng mục truy xuất cuối cùng (trần giới hạn): tổng cộng mức toàn văn + mức tóm tắt không vượt quá nó */
  finalRecallCount: number;
  /**
   * Số tầng AI bắt đầu truy xuất: khi số lượng tin nhắn AI của cuộc trò chuyện hiện tại ít hơn giá trị này thì **không kích hoạt truy xuất** (0 = không giới hạn).
   * Tính bằng số lượng tin nhắn AI (cùng tiêu chuẩn với keepRecent), tránh nhầm lẫn với "tầng lầu".
   * Cốt truyện giai đoạn đầu chưa có bao nhiêu ký ức cũ để truy xuất, bỏ qua giúp tiết kiệm hạn mức / độ trễ; bản lưu cũ của "Tạo cuộc trò chuyện mới kèm dữ liệu" không chịu giới hạn này (luôn truy xuất).
   */
  minAiFloors: number;
}

/** Cài đặt trí nhớ vector. embedding làm chuẩn, url của rerank/queryRewrite để trống thì tái sử dụng của embedding. */
export interface VectorSettings {
  /** Công tắc trí nhớ vector */
  enabled: boolean;
  /** Điểm cuối vector hóa văn bản (mốc chuẩn, bắt buộc điền) */
  embedding: VectorEndpoint;
  /** Điểm cuối xếp hạng lại (rerank); url để trống thì tái sử dụng embedding */
  rerank: VectorEndpoint;
  /** Điểm cuối viết lại truy vấn; url để trống thì tái sử dụng embedding */
  queryRewrite: VectorEndpoint;
  /** Token đầu ra tối đa một lần của viết lại truy vấn (trong ba vai trò chỉ có nó là sinh văn bản; đủ chỗ đặt INTENT + nhiều Q là được, hơi nhỏ sẽ bị cắt cụt). Mặc định 8192. */
  queryRewriteMaxTokens: number;
  /** Tham số truy xuất (số ứng viên/ngưỡng/số lượng mục) */
  recall: VectorRecallSettings;
}

/** Phần cần đồng bộ xuyên thiết bị trong tùy chọn giao diện (giao diện chủ đề / vị trí điều hướng); trạng thái tạm thời thuần trên máy như activePage không nằm ở đây. */
export interface UiPrefs {
  /** Tên giao diện chủ đề (giá trị hợp lệ xem THEMES trong state/ui.ts; ở đây chỉ lưu chuỗi, tránh việc settings phụ thuộc ngược vào ui) */
  theme: string;
  /** Vị trí điều hướng: top/bottom/auto */
  navPosition: string;
  /** Thiết bị di động: bấm lại nút điều hướng của trang hiện tại sẽ đóng toàn bộ cửa sổ. Mặc định bật; người dùng sợ chạm nhầm có thể tắt. */
  navTapClose: boolean;
  /** Tiêm một nút mở nhanh vào thanh trên cùng của ST (lối vào menu đũa phép vẫn giữ nguyên như cũ). Mặc định tắt. */
  showTopBar: boolean;
  /** Tiêm nút kiểu "Trả lời nhanh" ở phía trên khung trò chuyện, bấm vào để mở Bách Bảo Thư. Mặc định tắt. */
  showQuickReply: boolean;
  /** Tiêm mốc neo tóm tắt vào bên trong mỗi tầng lầu AI (xem dữ liệu tóm tắt tầng đó + đánh dấu ngoại truyện). Mặc định tắt. */
  showFloorPanel: boolean;
  /** Quả cầu nổi ở mép màn hình, bấm vào để mở Bách Bảo Thư. Mặc định tắt. */
  showOrb: boolean;
  /** Biểu tượng tùy chỉnh của quả cầu nổi: đường dẫn ảnh trên máy chủ ST (chuỗi ngắn do saveBase64AsFile trả về); trống = dùng biểu tượng dấu trang mặc định. Đồng bộ xuyên thiết bị. */
  orbImage: string;
  /** Hình dạng quả cầu nổi: bookmark dấu trang (mặc định) / circle tròn / square vuông. */
  orbShape: string;
  /** Độ mờ của quả cầu nổi khi đứng yên (phần trăm 20–100, mặc định 62). Khi gọi lên / kéo đi đều hiển thị rõ hoàn toàn. */
  orbOpacity: number;
  /** Kích thước cơ sở của quả cầu nổi (px, 32–80, mặc định 48). Dấu trang phóng rộng cao theo tỷ lệ, tròn/vuông là độ dài cạnh đều. */
  orbSize: number;
}

/** Mức độ chi tiết số chữ: detailed=chi tiết (mặc định), concise=tinh giản (số chữ tóm tắt/tổng kết/tổng kết lần hai cùng giảm xuống). Chỉ ảnh hưởng khuôn mẫu tích hợp sẵn. */
export type Verbosity = 'detailed' | 'concise';

/**
 * Cài đặt tiêm: các khối trạng thái có được tiêm vào **mô hình chính** (yêu cầu sinh chính văn) hay không.
 * Chỉ ảnh hưởng buildStateInjectionText; tóm tắt API phụ luôn nhìn thấy toàn bộ trạng thái và ghi chép như thường (chống ghi trùng lặp), không bị ảnh hưởng bởi cài đặt này.
 * Quan hệ phụ thuộc: phân mức có mặt của danh sách NPC và phán đoán khả năng tiếp cận của danh sách vật phẩm đều đi qua cây bối cảnh,
 * nên khi tắt scenes thì thực tế npcs/items cũng không được tiêm (giao diện đồng bộ làm xám); trạng thái nhân vật chính tự khép kín, không phụ thuộc bối cảnh.
 */
export interface InjectionSections {
  /** Cục diện trước mắt (thẻ cục diện tương tác sceneFocus) */
  sceneFocus: boolean;
  /** Chi tiết đời sống của nhân vật chính và nhân vật chính yếu (chỉ kiểm soát việc tiêm; việc ghi chép luôn bật, không có công tắc —— khi không tiêm thì ghi bao nhiêu cũng không ảnh hưởng chính văn) */
  lifeDetails: boolean;
  /** Trạng thái hiện tại của nhân vật chính (giới tính/tuổi/ngoại hình/trang phục/trạng thái) */
  protagonist: boolean;
  /** Danh sách NPC (phụ thuộc thông tin bối cảnh) */
  npcs: boolean;
  /** Ước lượng hảo cảm 5 mức bên trong danh sách NPC (hảo cảm nội tâm/thái độ bên ngoài/giải thích); sau khi tắt danh sách vẫn gửi như thường, chỉ là không kèm theo hảo cảm.
   *  Phù hợp với trường hợp thẻ nhân vật đã có sẵn hệ thống hảo cảm, không muốn hai bộ chạy song song. Chỉ kiểm soát việc tiêm, việc ghi chép và hiển thị trên trang luôn bật. */
  npcAffinity: boolean;
  /** Danh sách vật phẩm (phụ thuộc thông tin bối cảnh) */
  items: boolean;
  /** Thông tin bối cảnh (địa điểm hiện tại + chuỗi tổ tiên + các địa điểm đã biết khác); sau khi tắt thì NPC/vật phẩm cũng theo đó không tiêm */
  scenes: boolean;
  /** Danh sách hiểu biết của nhân vật về nhân vật chính. Khác với các mục khác, nó đồng thời quản lý cả việc "ghi chép": tắt đi là tiết kiệm luôn cả quy tắc ở API phụ (0 token), danh sách đã có được giữ lại.
   *  Không phụ thuộc việc tiêm bối cảnh —— phán đoán có mặt đọc dữ liệu bộ nhớ, chứ không phải văn bản tiêm. */
  knowledge: boolean;
}

export interface ApiSettings {
  /** Công tắc tổng của plugin. Sau khi tắt sẽ dừng mọi việc tự động tiêm/tóm tắt/tổng kết/ẩn; lối vào menu ST vẫn còn, có thể mở lại giao diện để bật lại. */
  enabled: boolean;
  /** Tùy chọn giao diện (chủ đề/vị trí điều hướng), lưu vào extension_settings cùng cài đặt → đồng bộ xuyên thiết bị */
  ui: UiPrefs;
  /** Khuôn mẫu prompt tùy chỉnh (trống = dùng tích hợp sẵn) */
  prompts: CustomPrompts;
  /** Mức độ chi tiết số chữ của khuôn mẫu tích hợp sẵn: chi tiết/tinh giản. Khuôn mẫu tùy chỉnh không bị ảnh hưởng. */
  verbosity: Verbosity;
  /** Cấu hình trí nhớ vector */
  vector: VectorSettings;
  channels: ApiChannel[];
  /** ID kênh được chỉ định cho từng tác vụ */
  assignments: Record<TaskType, string>;
  /** Công tắc tự động tóm tắt. Bật lên là kích hoạt cùng lúc: tự động ẩn, thẻ thời gian chính văn, chặn tồn đọng (không còn tách công tắc riêng lẻ nữa). */
  autoSummaryEnabled: boolean;
  /**
   * Chế độ chỉ tóm tắt. Tiếp tục phân tích, lưu trạng thái có cấu trúc, nhưng không tiêm trạng thái hiện tại vào mô hình chính,
   * và cũng không còn ghi chú thích biến động vật phẩm / biến số trở lại chính văn nữa. Các chú thích chính văn đã có không chủ động dọn dẹp.
   */
  summaryOnlyMode: boolean;
  /** Cài đặt tiêm: các khối trạng thái có tiêm vào mô hình chính hay không (khi bật chế độ chỉ tóm tắt thì cả nhóm không có hiệu lực) */
  injection: InjectionSections;
  /** Giữ lại N tin nhắn AI gần nhất gửi toàn văn (cửa sổ trượt); các tin nhắn sớm hơn tự động tóm tắt và ẩn đi */
  keepRecent: number;
  /** Tên nhân vật bị loại trừ: trong cuộc trò chuyện của những tên này (gồm cả thẻ trùng tên), mọi tính năng của hệ thống trí nhớ đều không có hiệu lực */
  excludedChars: string[];
  /** Tên file sách thế giới **loại trừ cả cuốn** khi tóm tắt/tổng kết: mọi mục kích hoạt của những cuốn sách này đều không đi vào ngữ cảnh tóm tắt.
   *  Dùng cho các sách kiến thức phụ gắn toàn cục v.v. —— chúng vô ích đối với việc tóm tắt cốt truyện hiện tại, loại trừ giúp tiết kiệm token. Chỉ ảnh hưởng API phụ. */
  excludedWorldNames: string[];
  /** Quy tắc lọc theo **tên mục (comment)** khi tóm tắt/tổng kết: mục trúng bất kỳ quy tắc nào sẽ không đi vào ngữ cảnh tóm tắt.
   *  Mỗi mục được biên dịch như regex (tên thông thường tự nhiên = khớp bao hàm), biên dịch thất bại thì hạ cấp thành bao hàm chuỗi con nguyên văn. Chỉ ảnh hưởng API phụ. */
  excludedWorldInfoPatterns: string[];
  /** Quy tắc tên mục mặc định tích hợp sẵn đã được "gieo hạt" vào danh sách bên trên hay chưa (xem DEFAULT_WI_PATTERNS / hydrateSettings).
   *  Chỉ cấp phát một lần: người dùng cũ lần đầu tải sẽ được bù quy tắc mặc định và đặt thành true; về sau người dùng có xóa trống cũng không tự nhét lại nữa, tôn trọng lựa chọn của họ. */
  wiPatternsSeeded: boolean;
  /** Kết xuất khuôn mẫu sách thế giới (mặc định bật): trước khi API phụ tóm tắt lấy mục sách thế giới, mở rộng {{macro}} trước và thực thi EJS (<% %>) của
   *  ST-Prompt-Template, để các mục động như "chuyển đổi thiết lập theo độ hảo cảm" nhận được thành phẩm thay vì nguyên văn. Tác dụng phụ: EJS có chứa ghi biến mỗi lần tóm tắt
   *  đều sẽ thực thi thêm một lần, làm bẩn trạng thái biến —— gặp loại sách thế giới này có thể tắt đi. Khi chưa cài ST-Prompt-Template thì chỉ mở rộng macro. */
  renderWorldInfoTemplates: boolean;
  /** Khi tóm tắt lá tích lũy đến N mục, nén thành một tổng kết L1 (ngưỡng L0→L1, 0 = tắt) */
  leafBatchThreshold: number;
  /**
   * Khi tổng kết **giữ lại N tóm tắt gần nhất ở tầng lá không nén** (chỉ có hiệu lực với L0→L1, không ảnh hưởng tầng cao hơn).
   * Tác dụng: sau khi việc nén gộp một loạt lá thành một đoạn L1, đầu tiêm chỉ đi theo "gốc" —— các lá đã được thu nạp không còn tiêm riêng lẻ nữa,
   * độ chi tiết hạt mịn sẽ mất đi một lượt ("vách đá" mà người dùng thực tế gặp phải). Chừa lại một đoạn lá mới nhất làm gốc, đầu tiêm luôn có chi tiết đỡ đáy.
   * Cơ chế: ngưỡng kích hoạt nâng lên thành `leafBatchThreshold + leafKeepRecent`, nhưng mỗi lần vẫn chỉ nén `leafBatchThreshold` mục
   * cũ nhất (không làm đổi chất lượng tổng kết), N mục mới nhất tự nhiên được giữ lại.
   * 0 = giữ hành vi cũ (tích lũy đủ là nén hết); mặc định 3. Đặt quá lớn = mãi không nén, lá chất đống. */
  leafKeepRecent: number;
  /** Mỗi khi L1 tích lũy đến N mục, nén thành một tổng kết L2 (ngưỡng L1→L2, 0 = tắt) */
  resummaryThreshold: number;
  /** Mỗi khi L2 trở lên tích lũy đến N mục, nén thành một tổng kết tầng ngay trên (ngưỡng L≥2→L+1, 0 = tắt) */
  higherResummaryThreshold: number;
  /** Số lượng mục "kế hoạch/nghi vấn đã hoàn thành gần đây" đính kèm trong ảnh chụp trạng thái: **kế hoạch, nghi vấn mỗi loại lấy N mục gần nhất** (0 = không đính kèm).
   *  Chống việc AI coi kế hoạch vừa khép lại là chưa hoàn thành rồi lại đi thúc đẩy / add lại; hai đầu tiêm và tóm tắt API phụ đính kèm cùng tiêu chuẩn. */
  recentResolvedPlansCount: number;
  /** Số lần thử lại tối đa khi tóm tắt/tổng kết thất bại (yêu cầu báo lỗi hoặc phân tích JSON thất bại). 0 = không thử lại; mặc định 1 (thử lại tối đa một lần). */
  summaryMaxRetries: number;
  /** Tóm tắt bù hàng loạt: số ký tự chính văn tối đa mỗi đợt (sau khi làm sạch). Tích lũy đủ là cắt khối, kiểm soát quy mô một yêu cầu đơn lẻ (chống việc AI bị phân tán sự chú ý). */
  batchMaxChars: number;
  /** Tóm tắt bù hàng loạt: trần số tầng tối đa mỗi đợt làm dự phòng. Cho dù số ký tự chưa chạm trần, số tầng đến mức này cũng cắt khối. */
  batchMaxFloors: number;
  /**
   * Tên thẻ "xóa nguyên khối" do người dùng tùy chỉnh (chỉ điền tên thẻ, không kèm ngoặc nhọn, như snow). Khi làm sạch chính văn
   * `<snow>…</snow>` cùng nội dung bên trong sẽ bị xóa bỏ luôn. Dùng để loại bỏ các định dạng thanh trạng thái,
   * chú thích bên lề v.v. do plugin / sách thế giới khác ghi vào chính văn. Thay đổi có hiệu lực tức thì **vào lúc truy xuất** (kho vector lưu nguyên văn, khi truy xuất mới làm sạch), không cần dựng lại chỉ mục.
   */
  customStripTags: string[];
  /** Khuôn mẫu biến toàn cục: cấu trúc JSON ban đầu + hướng dẫn dùng chung cho mọi nhân vật mọi cuộc trò chuyện (giá trị vẫn độc lập theo từng cuộc trò chuyện). Xem VarTier của memory. */
  varsGlobalTemplate: VarTemplate;
  /** Khuôn mẫu biến nhân vật: khóa = tên file avatar thẻ nhân vật, giá trị = khuôn mẫu ban đầu dùng chung cho mọi cuộc trò chuyện của nhân vật đó (giá trị vẫn độc lập theo từng cuộc trò chuyện). */
  varsTemplateByChar: Record<string, VarTemplate>;
}

// Khóa không gian tên trong extension_settings; localStorage là tàn dư bản cũ, chỉ dùng để di chuyển một lần.
const SETTINGS_KEY = 'baibai_book';
const SHARED_CHANNELS_KEY = 'baibai_api_channels';
const SHARED_CHANNELS_EVENT = 'st-baibai-api-channels:changed';
const SHARED_CHANNELS_SCHEMA_VERSION = 1;

/* —— Lưu trữ dùng chung cài đặt loại trừ: dùng chung cùng một danh sách loại trừ với các plugin "Bách Bảo" như Bách Bảo Hội (cùng giao thức với kênh) ——
   Bản gốc lưu ở extensionSettings[SHARED_EXCLUDES_KEY] (kèm revision), trong cài đặt của từng plugin chỉ giữ bản sao gương.
   Sau khi bất kỳ đầu nào ghi vào sẽ phát quảng bá sự kiện, các đầu khác nhận được sẽ đọc lại từ extensionSettings và áp dụng, thực hiện đồng bộ thời gian thực xuyên plugin.
   Ngữ nghĩa hai đầu nhất quán: nhân vật loại trừ = ngừng tính năng, loại trừ cả cuốn/tên mục = lọc sách thế giới API phụ, thẻ làm sạch = xóa nguyên khối trong chính văn. */
const SHARED_EXCLUDES_KEY = 'baibai_exclude_settings';
const SHARED_EXCLUDES_EVENT = 'st-baibai-exclude-settings:changed';
const SHARED_EXCLUDES_SCHEMA_VERSION = 1;

interface SharedChannelsStore {
  schemaVersion: number;
  revision: number;
  channels: ApiChannel[];
}

interface SharedExcludesStore {
  schemaVersion: number;
  revision: number;
  excludedChars: string[];
  excludedWorldNames: string[];
  excludedWorldInfoPatterns: string[];
  customStripTags: string[];
}

/** Quy tắc mặc định tích hợp sẵn của lọc tên mục: khi tải lần đầu sẽ "gieo hạt" vào danh sách người dùng (xem hydrateSettings), về sau người dùng có thể tự do thêm xóa.
 *  \[mvu…\] = lọc các mục cơ chế của framework biến số MVU (đối với tóm tắt cốt truyện là nhiễu thuần túy). Không phân biệt hoa thường (engine biên dịch kèm cờ i). */
const DEFAULT_WI_PATTERNS = ['\\[mvu[\\s\\S]*?\\]'];
const LEGACY_STORAGE_KEY = 'bbs.api.v1';
// Tùy chọn giao diện bản cũ (chủ đề/vị trí điều hướng/phân trang) từng lưu riêng tại đây; nay chuyển chủ đề + điều hướng vào ui, phân trang vẫn để lại trên máy (xem state/ui.ts).
const LEGACY_UI_STORAGE_KEY = 'bbs.ui.v1';

/** Lấy chủ đề / vị trí điều hướng từ localStorage cũ (bbs.ui.v1), điền vào target.ui. Chỉ gọi một lần khi trên server chưa có ui. */
function migrateLegacyUiPrefs(target: ApiSettings): void {
  try {
    const raw = localStorage.getItem(LEGACY_UI_STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Partial<UiPrefs>;
    if (typeof obj.theme === 'string') target.ui.theme = obj.theme;
    if (typeof obj.navPosition === 'string') target.ui.navPosition = obj.navPosition;
  } catch {
    /* Phân tích thất bại thì giữ nguyên mặc định, không chặn */
  }
}

function defaults(): ApiSettings {
  return {
    enabled: true,
    ui: {
      theme: 'day',
      navPosition: 'auto',
      navTapClose: true,
      showTopBar: false,
      showQuickReply: false,
      showFloorPanel: false,
      showOrb: false,
      orbImage: '',
      orbShape: 'bookmark',
      orbOpacity: 62,
      orbSize: 48,
    },
    prompts: { summary: '', resummary: '', resummary2: '', jailbreak: '', timeTag: '' },
    verbosity: 'detailed',
    vector: {
      enabled: false,
      // Mặc định điền địa chỉ SiliconFlow + mô hình từng vai trò, người dùng chỉ cần điền key một lần ở embedding là chạy thông suốt:
      // url/key của rerank/queryRewrite để trống sẽ lùi về tái sử dụng của embedding (xem resolveVectorModel).
      embedding: { url: 'https://api.siliconflow.cn/v1', key: '', model: 'Qwen/Qwen3-Embedding-8B', timeoutSec: 10, retries: 1 },
      rerank: { url: '', key: '', model: 'Qwen/Qwen3-Reranker-4B', timeoutSec: 20, retries: 1 },
      queryRewrite: { url: '', key: '', model: 'Qwen/Qwen3.5-27B', timeoutSec: 90, retries: 1 },
      queryRewriteMaxTokens: 8192,
      recall: {
        injectionDepth: DEFAULT_RECALL_INJECTION_DEPTH,
        rerankCandidates: 20,
        embeddingThreshold: 0.8,
        rerankThreshold: 0.9,
        fullTextCount: 2,
        finalRecallCount: 5,
        minAiFloors: 30,
      },
    },
    channels: [],
    assignments: { summary: '', resummary: '' },
    autoSummaryEnabled: true,
    summaryOnlyMode: false,
    injection: { sceneFocus: true, lifeDetails: true, protagonist: true, npcs: true, npcAffinity: true, items: true, scenes: true, knowledge: true },
    keepRecent: 3,
    excludedChars: [],
    excludedWorldNames: [],
    // Khởi đầu trống: quy tắc mặc định tích hợp sẵn (DEFAULT_WI_PATTERNS) do hydrateSettings "gieo hạt" cấp phát, chỉ cấp một lần.
    // Như vậy người dùng cũ (đã lưu mảng rỗng) cũng được bù mặc định, và sau khi người dùng xóa trống sẽ không bị nhét lại nhiều lần.
    excludedWorldInfoPatterns: [],
    wiPatternsSeeded: false,
    renderWorldInfoTemplates: true,
    leafBatchThreshold: 12,
    leafKeepRecent: 3,
    resummaryThreshold: 6,
    higherResummaryThreshold: 3,
    recentResolvedPlansCount: 5,
    summaryMaxRetries: 1,
    batchMaxChars: 30000,
    batchMaxFloors: 10,
    customStripTags: [],
    varsGlobalTemplate: { json: {}, meaning: '', rule: '' },
    varsTemplateByChar: {},
  };
}

/** Gộp đối tượng thô từ nguồn bất kỳ vào giá trị mặc định, chịu lỗi thiếu trường / sai kiểu dữ liệu. */
function normalize(raw: unknown): ApiSettings {
  if (!raw || typeof raw !== 'object') return defaults();
  const d = defaults();
  const merged = { ...d, ...(raw as Partial<ApiSettings>) };
  // prompts là đối tượng lồng nhau, gộp trải phẳng sẽ không bổ sung đủ các trường bị thiếu, dự phòng riêng (khi dữ liệu cũ không có khóa prompts thì lùi về mặc định)
  merged.prompts = { ...d.prompts, ...((raw as Partial<ApiSettings>).prompts ?? {}) };
  // ui cũng là đối tượng lồng nhau, dự phòng từng trường (khi dữ liệu cũ không có khóa ui thì lùi về mặc định, giá trị không phải chuỗi thì bỏ)
  const ru = ((raw as Partial<ApiSettings>).ui ?? {}) as Partial<UiPrefs>;
  merged.ui = {
    theme: typeof ru.theme === 'string' ? ru.theme : d.ui.theme,
    navPosition: typeof ru.navPosition === 'string' ? ru.navPosition : d.ui.navPosition,
    navTapClose: typeof ru.navTapClose === 'boolean' ? ru.navTapClose : d.ui.navTapClose,
    showTopBar: typeof ru.showTopBar === 'boolean' ? ru.showTopBar : d.ui.showTopBar,
    showQuickReply: typeof ru.showQuickReply === 'boolean' ? ru.showQuickReply : d.ui.showQuickReply,
    showFloorPanel: typeof ru.showFloorPanel === 'boolean' ? ru.showFloorPanel : d.ui.showFloorPanel,
    showOrb: typeof ru.showOrb === 'boolean' ? ru.showOrb : d.ui.showOrb,
    orbImage: typeof ru.orbImage === 'string' ? ru.orbImage : d.ui.orbImage,
    orbShape: typeof ru.orbShape === 'string' ? ru.orbShape : d.ui.orbShape,
    // Độ mờ: kẹp vào khoảng 20–100, thiếu / không hợp lệ lùi về mặc định (thấp quá sẽ không nhìn thấy, đặt cận dưới là 20)
    orbOpacity:
      typeof ru.orbOpacity === 'number' && Number.isFinite(ru.orbOpacity)
        ? Math.min(100, Math.max(20, Math.round(ru.orbOpacity)))
        : d.ui.orbOpacity,
    // Kích thước: kẹp vào khoảng 32–80, thiếu / không hợp lệ lùi về mặc định
    orbSize:
      typeof ru.orbSize === 'number' && Number.isFinite(ru.orbSize)
        ? Math.min(80, Math.max(32, Math.round(ru.orbSize)))
        : d.ui.orbSize,
  };
  // excludedChars bắt buộc phải là mảng chuỗi, khi giá trị cũ sai kiểu thì lùi về mảng rỗng
  merged.excludedChars = Array.isArray(merged.excludedChars)
    ? merged.excludedChars.filter((x): x is string => typeof x === 'string')
    : [];
  // Loại trừ sách thế giới / quy tắc tên mục: mảng chuỗi, bỏ rỗng, dữ liệu cũ thiếu / không hợp lệ lùi về mảng rỗng
  merged.excludedWorldNames = Array.isArray(merged.excludedWorldNames)
    ? merged.excludedWorldNames.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  merged.excludedWorldInfoPatterns = Array.isArray(merged.excludedWorldInfoPatterns)
    ? merged.excludedWorldInfoPatterns.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  // Nhãn gieo hạt: boolean, thiếu (dữ liệu cũ không có khóa này) lùi về false, để hydrateSettings cấp phát bù quy tắc mặc định trong lần đầu
  merged.wiPatternsSeeded = typeof merged.wiPatternsSeeded === 'boolean' ? merged.wiPatternsSeeded : false;
  // Kết xuất khuôn mẫu sách thế giới: boolean, thiếu (dữ liệu cũ không có khóa này) lùi về true (mặc định bật, để các mục sách thế giới động nhận được thành phẩm)
  merged.renderWorldInfoTemplates =
    typeof merged.renderWorldInfoTemplates === 'boolean' ? merged.renderWorldInfoTemplates : true;
  // Cài đặt tiêm: đối tượng lồng nhau, dự phòng từng trường (khi dữ liệu cũ không có khóa injection thì tất cả lùi về true = hành vi cũ không đổi)
  const ri = ((raw as Partial<ApiSettings>).injection ?? {}) as Partial<InjectionSections>;
  merged.injection = {
    sceneFocus: typeof ri.sceneFocus === 'boolean' ? ri.sceneFocus : true,
    lifeDetails: typeof ri.lifeDetails === 'boolean' ? ri.lifeDetails : true,
    protagonist: typeof ri.protagonist === 'boolean' ? ri.protagonist : true,
    npcs: typeof ri.npcs === 'boolean' ? ri.npcs : true,
    npcAffinity: typeof ri.npcAffinity === 'boolean' ? ri.npcAffinity : true,
    items: typeof ri.items === 'boolean' ? ri.items : true,
    scenes: typeof ri.scenes === 'boolean' ? ri.scenes : true,
    knowledge: typeof ri.knowledge === 'boolean' ? ri.knowledge : true,
  };
  // vector cũng là đối tượng lồng nhau (và bên trong có chứa đối tượng con), dự phòng từng tầng, dữ liệu cũ thiếu trường thì lùi về mặc định.
  // Lưu ý: cấu trúc cũ từng có vector.channels + {channel,model}; sau khi làm phẳng đã bỏ dùng, dự phòng từng vai trò theo url/key/model,
  // dữ liệu cũ thiếu các trường này sẽ lùi về chuỗi rỗng (đồng nghĩa "chưa cấu hình", người dùng điền lại một lần là được).
  const rv = ((raw as Partial<ApiSettings>).vector ?? {}) as Partial<VectorSettings>;
  merged.vector = {
    ...d.vector,
    ...rv,
    embedding: normalizeVectorEndpoint(rv.embedding, d.vector.embedding),
    rerank: normalizeVectorEndpoint(rv.rerank, d.vector.rerank),
    queryRewrite: normalizeVectorEndpoint(rv.queryRewrite, d.vector.queryRewrite),
    recall: { ...d.vector.recall, ...(rv.recall ?? {}) },
  };
  // Độ sâu tiêm truy xuất: số nguyên không âm; cấu hình cũ thiếu, không hợp lệ hoặc ô nhập tạm thời để trống thì lùi về D0.
  merged.vector.recall.injectionDepth = normalizeRecallInjectionDepth(merged.vector.recall.injectionDepth);
  // Số tầng AI bắt đầu truy xuất: số nguyên không âm, thiếu / không hợp lệ lùi về 0 (không giới hạn)
  merged.vector.recall.minAiFloors =
    Number.isFinite(merged.vector.recall.minAiFloors) && merged.vector.recall.minAiFloors >= 0
      ? Math.floor(merged.vector.recall.minAiFloors)
      : 0;
  // Token đầu ra tối đa của viết lại truy vấn: số nguyên dương, cận dưới 256 (nhỏ quá sẽ cắt cụt INTENT/Q), thiếu / không hợp lệ lùi về mặc định 8192
  merged.vector.queryRewriteMaxTokens =
    Number.isFinite(merged.vector.queryRewriteMaxTokens) && merged.vector.queryRewriteMaxTokens >= 256
      ? Math.floor(merged.vector.queryRewriteMaxTokens)
      : 8192;
  // Kênh API phụ: bổ sung đầy đủ các trường mới thêm cho từng kênh (dữ liệu cũ không có timeoutSec/stream/excludeParams), và kiểm tra kiểu dữ liệu
  merged.channels = (Array.isArray(merged.channels) ? merged.channels : []).map(normalizeChannel);
  // Mức số chữ: chỉ có hai giá trị hợp lệ, dữ liệu cũ thiếu / không hợp lệ lùi về chi tiết (= hành vi người dùng cũ không đổi)
  merged.verbosity = merged.verbosity === 'concise' ? 'concise' : 'detailed';
  // Số lượng mục giữ lại ở tầng lá: số nguyên không âm, thiếu / không hợp lệ lùi về mặc định 3 (0 = hành vi cũ tích lũy đủ là nén hết)
  merged.leafKeepRecent =
    Number.isFinite(merged.leafKeepRecent) && merged.leafKeepRecent >= 0
      ? Math.floor(merged.leafKeepRecent)
      : 3;
  // Ngưỡng tổng kết tầng cao: khi cấu hình cũ không có trường này thì bù 3, tránh việc L2 tiếp tục chất đống theo mốc 7 mục thành văn bản quá dài
  merged.higherResummaryThreshold =
    Number.isFinite(merged.higherResummaryThreshold) && merged.higherResummaryThreshold >= 0
      ? Math.floor(merged.higherResummaryThreshold)
      : 3;
  // Số lượng mục kế hoạch đã hoàn thành gần đây: số nguyên không âm, thiếu / không hợp lệ lùi về mặc định 5 (kế hoạch/nghi vấn mỗi loại lấy N; 0 = không đính kèm)
  merged.recentResolvedPlansCount =
    Number.isFinite(merged.recentResolvedPlansCount) && merged.recentResolvedPlansCount >= 0
      ? Math.floor(merged.recentResolvedPlansCount)
      : 5;
  // Số lần thử lại: số nguyên không âm, dữ liệu cũ thiếu / không hợp lệ lùi về mặc định 1
  merged.summaryMaxRetries =
    Number.isFinite(merged.summaryMaxRetries) && merged.summaryMaxRetries >= 0
      ? Math.floor(merged.summaryMaxRetries)
      : 1;
  // Tham số tóm tắt bù hàng loạt: số nguyên dương, thiếu / không hợp lệ lùi về giá trị mặc định (cận dưới 1, tránh số 0 dẫn đến không bao giờ cắt khối / vòng lặp vô tận)
  merged.batchMaxChars =
    Number.isFinite(merged.batchMaxChars) && merged.batchMaxChars >= 500
      ? Math.floor(merged.batchMaxChars)
      : 30000;
  merged.batchMaxFloors =
    Number.isFinite(merged.batchMaxFloors) && merged.batchMaxFloors >= 1
      ? Math.floor(merged.batchMaxFloors)
      : 10;
  // Thẻ làm sạch tùy chỉnh: chịu lỗi khi người dùng điền cả dấu ngoặc nhọn / gạch chéo vào (<snow> / </snow>), chỉ giữ lại các ký tự tên thẻ hợp lệ;
  // bỏ rỗng, khử trùng, thiếu / không phải mảng thì lùi về mảng rỗng.
  merged.customStripTags = Array.isArray(merged.customStripTags)
    ? Array.from(
      new Set(
        merged.customStripTags
          .filter((x): x is string => typeof x === 'string')
          .map(sanitizeTagName)
          .filter(Boolean),
      ),
    )
    : [];
  // Khuôn mẫu biến: chuẩn hóa sâu toàn cục; theo nhân vật chuẩn hóa từng bản theo khóa avatar (hủy bỏ khóa của khuôn mẫu rỗng, giữ lưu trữ sạch sẽ)
  merged.varsGlobalTemplate = normalizeTemplate((raw as Partial<ApiSettings>).varsGlobalTemplate);
  const rawByChar = (raw as Partial<ApiSettings>).varsTemplateByChar;
  const byChar: Record<string, VarTemplate> = {};
  if (rawByChar && typeof rawByChar === 'object') {
    for (const [k, v] of Object.entries(rawByChar)) {
      const tpl = normalizeTemplate(v);
      if (Object.keys(tpl.json).length || tpl.meaning.trim() || tpl.rule.trim()) byChar[k] = tpl; // Khác rỗng mới giữ lại
    }
  }
  merged.varsTemplateByChar = byChar;
  return merged;
}

/**
 * Chuẩn hóa đầu vào của người dùng thành tên thẻ có thể ghép an toàn vào regex.
 * Dùng danh sách đen (thay vì danh sách trắng) loại bỏ các ký tự nguy hiểm sẽ phá hỏng cú pháp thẻ / regex: ngoặc nhọn, gạch chéo, khoảng trắng, siêu ký tự regex;
 * các chữ cái Unicode nhất loạt giữ lại (người dùng có thể viết thẻ tiếng Việt hoặc Unicode khác).
 */
export function sanitizeTagName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^<\/?/, '') // < hoặc </ ở đầu
    .replace(/>$/, '') // > ở cuối
    .trim()
    .replace(/[<>/\\\s.*+?^${}()|[\]]/g, ''); // Loại bỏ ngoặc nhọn/gạch chéo/khoảng trắng/siêu ký tự regex, chữ cái giữ lại
}

/** Bổ sung đầy đủ các trường của một điểm cuối vector đơn lẻ và kiểm tra kiểu dữ liệu (thiếu / sai kiểu lùi về chuỗi rỗng). */
function normalizeVectorEndpoint(
  e: Partial<VectorEndpoint> | undefined,
  def: Pick<VectorEndpoint, 'timeoutSec' | 'retries'>,
): VectorEndpoint {
  const o = e ?? {};
  return {
    url: typeof o.url === 'string' ? o.url : '',
    key: typeof o.key === 'string' ? o.key : '',
    model: typeof o.model === 'string' ? o.model : '',
    // Quá thời gian / thử lại ở dữ liệu cũ có thể thiếu: giá trị mặc định của mỗi vai trò khác nhau (embedding 10s / rerank 20s / query 90s),
    // bắt buộc phải lùi về theo mặc định vai trò được truyền vào, không thể lùi thống nhất về một giá trị.
    timeoutSec:
      typeof o.timeoutSec === 'number' && Number.isFinite(o.timeoutSec) && o.timeoutSec > 0
        ? o.timeoutSec
        : def.timeoutSec,
    retries:
      typeof o.retries === 'number' && Number.isFinite(o.retries) && o.retries >= 0
        ? Math.floor(o.retries)
        : def.retries,
  };
}

/** Bổ sung các trường còn thiếu của một kênh đơn lẻ (timeoutSec/stream/excludeParams được thêm vào sau), và kiểm tra kiểu dữ liệu. */
function normalizeChannel(c: Partial<ApiChannel>): ApiChannel {
  return {
    id: typeof c.id === 'string' ? c.id : `ch_${Date.now()}_${++chanSeq}`,
    name: typeof c.name === 'string' ? c.name : 'Kênh mới',
    url: typeof c.url === 'string' ? c.url : '',
    key: typeof c.key === 'string' ? c.key : '',
    model: typeof c.model === 'string' ? c.model : '',
    temperature: typeof c.temperature === 'number' ? c.temperature : 1.0,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 65535,
    timeoutSec:
      typeof c.timeoutSec === 'number' && Number.isFinite(c.timeoutSec) && c.timeoutSec > 0
        ? Math.floor(c.timeoutSec)
        : 180,
    stream: typeof c.stream === 'boolean' ? c.stream : false,
    excludeParams: Array.isArray(c.excludeParams)
      ? c.excludeParams.filter((x): x is string => typeof x === 'string')
      : [],
    // Trường thêm vào sau: kênh cũ không có khóa này → chuỗi rỗng (auto, không gửi tham số), hành vi hoàn toàn nhất quán với trước khi thêm trường
    reasoningEffort: typeof c.reasoningEffort === 'string' ? c.reasoningEffort.trim() : '',
  };
}

// Ở giai đoạn import thường ST chưa sẵn sàng, tạo reactive bằng giá trị mặc định trước; giá trị thực sẽ do hydrateSettings rót vào.
export const apiSettings = reactive<ApiSettings>(defaults());

// Cờ gác cổng: trước khi hydrate hoàn tất thì không ghi trả lại, tránh việc "giá trị mặc định" ghi đè mất cài đặt đã lưu trên máy chủ.
let ready = false;
let sharedChannelsFingerprint = '';
let sharedChannelsRevision = 0;
let sharedChannelsListenerBound = false;
let sharedExcludesFingerprint = '';
let sharedExcludesRevision = 0;
let sharedExcludesListenerBound = false;

// Các bên đăng ký cần được thông báo sau khi hydrate hoàn tất (như ui.ts: sau khi settings sẵn sàng mới lấy được chủ đề / vị trí điều hướng đồng bộ sang).
// Nếu lúc đăng ký đã sẵn sàng rồi thì gọi lại ngay lập tức, tránh lỡ nhịp thời gian.
const readyCbs: Array<() => void> = [];
export function onSettingsReady(cb: () => void): void {
  if (ready) cb();
  else readyCbs.push(cb);
}

function applyInto(target: ApiSettings, src: ApiSettings): void {
  target.enabled = src.enabled;
  target.ui = src.ui;
  target.prompts = src.prompts;
  target.verbosity = src.verbosity;
  target.vector = src.vector;
  target.channels = src.channels;
  target.assignments = src.assignments;
  target.autoSummaryEnabled = src.autoSummaryEnabled;
  target.summaryOnlyMode = src.summaryOnlyMode;
  target.injection = src.injection;
  target.keepRecent = src.keepRecent;
  target.excludedChars = src.excludedChars;
  target.excludedWorldNames = src.excludedWorldNames;
  target.excludedWorldInfoPatterns = src.excludedWorldInfoPatterns;
  target.wiPatternsSeeded = src.wiPatternsSeeded;
  target.renderWorldInfoTemplates = src.renderWorldInfoTemplates;
  target.leafBatchThreshold = src.leafBatchThreshold;
  target.leafKeepRecent = src.leafKeepRecent;
  target.resummaryThreshold = src.resummaryThreshold;
  target.higherResummaryThreshold = src.higherResummaryThreshold;
  target.recentResolvedPlansCount = src.recentResolvedPlansCount;
  target.summaryMaxRetries = src.summaryMaxRetries;
  target.batchMaxChars = src.batchMaxChars;
  target.batchMaxFloors = src.batchMaxFloors;
  target.customStripTags = src.customStripTags;
  target.varsGlobalTemplate = src.varsGlobalTemplate;
  target.varsTemplateByChar = src.varsTemplateByChar;
}

function channelFingerprint(channels: ApiChannel[]): string {
  return JSON.stringify(channels);
}

function readSharedChannels(raw: unknown): SharedChannelsStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<SharedChannelsStore>;
  if (!Array.isArray(store.channels)) return null;
  return {
    schemaVersion: SHARED_CHANNELS_SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    channels: store.channels.map(normalizeChannel),
  };
}

function writeSharedChannels(dispatch = true): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  sharedChannelsRevision += 1;
  const store: SharedChannelsStore = {
    schemaVersion: SHARED_CHANNELS_SCHEMA_VERSION,
    revision: sharedChannelsRevision,
    channels: JSON.parse(JSON.stringify(apiSettings.channels)) as ApiChannel[],
  };
  ctx.extensionSettings[SHARED_CHANNELS_KEY] = store;
  sharedChannelsFingerprint = channelFingerprint(store.channels);
  ctx.saveSettingsDebounced?.();
  if (dispatch) {
    window.dispatchEvent(
      new CustomEvent(SHARED_CHANNELS_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Book' },
      }),
    );
  }
}

function applySharedChannels(store: SharedChannelsStore): void {
  const fingerprint = channelFingerprint(store.channels);
  sharedChannelsRevision = Math.max(sharedChannelsRevision, store.revision);
  if (fingerprint === sharedChannelsFingerprint) return;
  apiSettings.channels = store.channels;
  sharedChannelsFingerprint = fingerprint;

  const ids = new Set(apiSettings.channels.map(channel => channel.id));
  if (apiSettings.assignments.summary && !ids.has(apiSettings.assignments.summary)) {
    apiSettings.assignments.summary = '';
  }
  if (apiSettings.assignments.resummary && !ids.has(apiSettings.assignments.resummary)) {
    apiSettings.assignments.resummary = '';
  }
}

function bindSharedChannelsListener(): void {
  if (sharedChannelsListenerBound) return;
  sharedChannelsListenerBound = true;
  window.addEventListener(SHARED_CHANNELS_EVENT, () => {
    const ctx = getContext();
    const store = readSharedChannels(ctx?.extensionSettings?.[SHARED_CHANNELS_KEY]);
    if (store) applySharedChannels(store);
  });
}

function hydrateSharedChannels(legacyChannels: ApiChannel[]): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  const stored = readSharedChannels(ctx.extensionSettings[SHARED_CHANNELS_KEY]);
  if (stored) {
    applySharedChannels(stored);
  } else {
    apiSettings.channels = legacyChannels.map(normalizeChannel);
    sharedChannelsFingerprint = channelFingerprint(apiSettings.channels);
    writeSharedChannels(false);
  }
  bindSharedChannelsListener();
}

/* ============ Lưu trữ dùng chung cài đặt loại trừ (dùng chung với Bách Bảo Hội, giao thức đồng cấu hoàn toàn với kênh) ============ */

function excludesFingerprint(ex: Pick<ApiSettings, 'excludedChars' | 'excludedWorldNames' | 'excludedWorldInfoPatterns' | 'customStripTags'>): string {
  return JSON.stringify([
    ex.excludedChars,
    ex.excludedWorldNames,
    ex.excludedWorldInfoPatterns,
    ex.customStripTags,
  ]);
}

/** Phán đoán xem trong danh sách ngoài quy tắc tên mục mặc định tích hợp sẵn (mvu) ra, có còn bất kỳ dữ liệu người dùng nào khác hay không. */
function excludesHasUserData(ex: Pick<ApiSettings, 'excludedChars' | 'excludedWorldNames' | 'excludedWorldInfoPatterns' | 'customStripTags'>): boolean {
  const patterns = ex.excludedWorldInfoPatterns.filter(p => !DEFAULT_WI_PATTERNS.includes(p));
  return (
    ex.excludedChars.length > 0 ||
    ex.excludedWorldNames.length > 0 ||
    patterns.length > 0 ||
    ex.customStripTags.length > 0
  );
}

/** Đọc nguyên bản bốn danh sách từ lưu trữ dùng chung, làm sạch từng danh sách theo cùng tiêu chuẩn với normalize cục bộ (thiếu trường / sai kiểu lùi về mảng rỗng). */
function readSharedExcludes(raw: unknown): SharedExcludesStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<SharedExcludesStore>;
  if (!Array.isArray(store.excludedChars)) return null;
  return {
    schemaVersion: SHARED_EXCLUDES_SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    excludedChars: store.excludedChars.filter((x): x is string => typeof x === 'string'),
    excludedWorldNames: Array.isArray(store.excludedWorldNames)
      ? store.excludedWorldNames.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [],
    excludedWorldInfoPatterns: Array.isArray(store.excludedWorldInfoPatterns)
      ? store.excludedWorldInfoPatterns.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [],
    customStripTags: Array.isArray(store.customStripTags)
      ? Array.from(
        new Set(
          store.customStripTags
            .filter((x): x is string => typeof x === 'string')
            .map(sanitizeTagName)
            .filter(Boolean),
        ),
      )
      : [],
  };
}

function writeSharedExcludes(dispatch = true): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  sharedExcludesRevision += 1;
  const store: SharedExcludesStore = {
    schemaVersion: SHARED_EXCLUDES_SCHEMA_VERSION,
    revision: sharedExcludesRevision,
    excludedChars: JSON.parse(JSON.stringify(apiSettings.excludedChars)) as string[],
    excludedWorldNames: JSON.parse(JSON.stringify(apiSettings.excludedWorldNames)) as string[],
    excludedWorldInfoPatterns: JSON.parse(JSON.stringify(apiSettings.excludedWorldInfoPatterns)) as string[],
    customStripTags: JSON.parse(JSON.stringify(apiSettings.customStripTags)) as string[],
  };
  ctx.extensionSettings[SHARED_EXCLUDES_KEY] = store;
  sharedExcludesFingerprint = excludesFingerprint(store);
  ctx.saveSettingsDebounced?.();
  if (dispatch) {
    window.dispatchEvent(
      new CustomEvent(SHARED_EXCLUDES_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Book' },
      }),
    );
  }
}

function applySharedExcludes(store: SharedExcludesStore): void {
  const fingerprint = excludesFingerprint(store);
  sharedExcludesRevision = Math.max(sharedExcludesRevision, store.revision);
  if (fingerprint === sharedExcludesFingerprint) return;
  apiSettings.excludedChars = store.excludedChars;
  apiSettings.excludedWorldNames = store.excludedWorldNames;
  apiSettings.excludedWorldInfoPatterns = store.excludedWorldInfoPatterns;
  apiSettings.customStripTags = store.customStripTags;
  sharedExcludesFingerprint = fingerprint;
}

function bindSharedExcludesListener(): void {
  if (sharedExcludesListenerBound) return;
  sharedExcludesListenerBound = true;
  window.addEventListener(SHARED_EXCLUDES_EVENT, () => {
    const ctx = getContext();
    const store = readSharedExcludes(ctx?.extensionSettings?.[SHARED_EXCLUDES_KEY]);
    if (store) applySharedExcludes(store);
  });
}

/**
 * Tiếp quản lưu trữ dùng chung cài đặt loại trừ: nếu tồn tại thì lấy bản dùng chung làm chuẩn ghi đè bản sao gương của plugin này;
 * nếu không tồn tại thì lấy danh sách hiện tại của plugin này (người dùng cũ đã cấu hình + quy tắc mặc định đã gieo hạt) làm hạt giống để ghi vào.
 * Việc gieo hạt chỉ xảy ra khi "chưa có lưu trữ", tự nhiên thỏa mãn nguyên tắc "chỉ cấp một lần, xóa rồi không bù lại", không cần nhãn phụ.
 *
 * Cổng bảo vệ tự phục hồi: lưu trữ dùng chung tồn tại nhưng hoàn toàn không có dữ liệu người dùng (nghi là tàn dư "hạt giống rỗng" của phiên bản sớm ——
 * plugin không có dữ liệu trước kia cũng tạo lưu trữ dùng chung, dẫn đến hai bên đồng bộ lẫn nhau thành trống trơn),
 * trong khi danh sách của plugin này vẫn còn dữ liệu người dùng → không nhận nuôi store rỗng, lấy plugin này làm chuẩn ghi trả lại vào lưu trữ dùng chung và phát quảng bá,
 * khôi phục dữ liệu thực sự về lại. Lưu ý: sau khi người dùng chủ động xóa trống danh sách ở bất kỳ đầu nào, kết quả xóa trống trong store
 * sẽ nhất quán với cục bộ (cùng fingerprint), sẽ không phán đoán nhầm.
 */
function hydrateSharedExcludes(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  const stored = readSharedExcludes(ctx.extensionSettings[SHARED_EXCLUDES_KEY]);
  if (stored) {
    if (!excludesHasUserData(stored) && excludesHasUserData(apiSettings)) {
      writeSharedExcludes(true);
    } else {
      applySharedExcludes(stored);
    }
  } else {
    sharedExcludesFingerprint = excludesFingerprint(apiSettings);
    writeSharedExcludes(false);
  }
  bindSharedExcludesListener();
}

/** Ghi trả lại vào extension_settings và chống rung lưu đĩa lên máy chủ (mấu chốt của đồng bộ xuyên thiết bị). */
function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
  const fingerprint = channelFingerprint(apiSettings.channels);
  if (fingerprint !== sharedChannelsFingerprint) writeSharedChannels();
  // Danh sách loại trừ có thay đổi → ghi đồng bộ vào lưu trữ dùng chung và phát quảng bá (đối chiếu dấu vân tay chống vòng lặp)
  const exFingerprint = excludesFingerprint(apiSettings);
  if (exFingerprint !== sharedExcludesFingerprint) writeSharedExcludes();
  ctx.saveSettingsDebounced?.();
}

/**
 * Gọi sau khi ST sẵn sàng: tải cài đặt thực từ extension_settings;
 * nếu ở đó chưa có, nhưng localStorage có giá trị cũ, thì di chuyển sang (người dùng cũ không mất cấu hình), di chuyển xong xóa khóa cũ.
 * Sau khi hoàn tất thì cho phép watch ghi trả lại. Có thể gọi lặp lại an toàn (chỉ thực sự hydrate ở lần đầu tiên).
 */
export function hydrateSettings(): void {
  if (ready) return;
  const ctx = getContext();
  if (!ctx?.extensionSettings) return; // ST chưa sẵn sàng, thử lại sau

  const stored = ctx.extensionSettings[SETTINGS_KEY];
  if (stored && typeof stored === 'object') {
    applyInto(apiSettings, normalize(stored));
    // Người dùng cũ: trên server đã có cài đặt api nhưng chưa từng đồng bộ tùy chọn giao diện → chuyển chủ đề/điều hướng từ localStorage cũ vào và lưu đĩa một lần
    if (!('ui' in (stored as object))) {
      migrateLegacyUiPrefs(apiSettings);
      ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
      ctx.saveSettingsDebounced?.();
    }
    try {
      localStorage.removeItem(LEGACY_UI_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  } else {
    // Di chuyển: trong extension_settings chưa có → thử chuyển từ localStorage cũ sang
    let migrated: ApiSettings | null = null;
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) migrated = normalize(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    if (migrated) applyInto(apiSettings, migrated);
    // Tùy chọn giao diện cũng chuyển từ localStorage cũ vào (người dùng mới cài không có khóa này thì giữ nguyên mặc định)
    migrateLegacyUiPrefs(apiSettings);
    // Ghi giá trị hiện tại (chuyển sang hoặc mặc định) vào extension_settings, xác lập nguồn đồng bộ
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
    ctx.saveSettingsDebounced?.();
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.removeItem(LEGACY_UI_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  hydrateSharedChannels(apiSettings.channels);

  // Gieo hạt quy tắc tên mục mặc định tích hợp sẵn: chỉ khi chưa từng cấp phát (người dùng cũ / người dùng mới lần đầu) mới bù vào danh sách, đồng thời đặt nhãn + lưu đĩa.
  // Chỉ cấp một lần —— về sau người dùng có xóa trống cũng không bị nhét lại nhiều lần. Nối thêm chứ không ghi đè, không đụng tới quy tắc tùy chỉnh đã có của người dùng.
  if (!apiSettings.wiPatternsSeeded) {
    for (const pat of DEFAULT_WI_PATTERNS) {
      if (!apiSettings.excludedWorldInfoPatterns.includes(pat)) apiSettings.excludedWorldInfoPatterns.push(pat);
    }
    apiSettings.wiPatternsSeeded = true;
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
    ctx.saveSettingsDebounced?.();
  }

  // Tiếp quản lưu trữ dùng chung danh sách loại trừ (sau bước gieo hạt: danh sách người dùng cũ / quy tắc mới gieo hạt được ghi vào làm hạt giống)
  hydrateSharedExcludes();

  ready = true;
  for (const cb of readyCbs.splice(0)) {
    try {
      cb();
    } catch {
      /* Lỗi bất thường của riêng bên đăng ký không chặn các bước tiếp theo */
    }
  }
}

watch(
  apiSettings,
  () => {
    if (!ready) return; // Trước khi hydrate không ghi trả lại, ngăn giá trị mặc định ghi đè cài đặt trên máy chủ
    persist();
  },
  { deep: true },
);

let chanSeq = 0;
export function newChannel(): ApiChannel {
  chanSeq += 1;
  return {
    id: `ch_${Date.now()}_${chanSeq}`,
    name: 'Kênh mới',
    url: '',
    key: '',
    model: '',
    temperature: 1.0,
    maxTokens: 65535,
    timeoutSec: 180,
    stream: false,
    excludeParams: [],
    reasoningEffort: '',
  };
}

/** Tên nhân vật của cuộc trò chuyện đơn nhân vật hiện tại; khi trò chuyện nhóm hoặc chưa vào cuộc trò chuyện thì trả về null (trò chuyện nhóm không tham gia loại trừ). */
export function currentCharName(): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  if (ctx.groupId) return null; // Trò chuyện nhóm: nhiều nhân vật, không loại trừ theo tên đơn
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)];
  return ch?.name ?? null;
}

/**
 * Khóa ổn định của nhân vật hiện tại: tên file avatar (duy nhất, thẻ trùng tên cũng không xung đột); không lấy được thì lùi về tên nhân vật.
 * Dùng làm khóa lưu trữ định nghĩa biến ở tầng nhân vật (varsByChar[key]). Trò chuyện nhóm / chưa vào cuộc trò chuyện trả về null (tầng nhân vật lúc này không áp dụng).
 */
export function currentCharKey(): string | null {
  const ctx = getContext();
  if (!ctx || ctx.groupId) return null; // Trò chuyện nhóm không có một nhân vật đơn lẻ
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)] as { avatar?: string; name?: string } | undefined;
  return ch?.avatar || ch?.name || null;
}

/**
 * Cuộc trò chuyện hiện tại có bị loại trừ hay không (tên nhân vật đó nằm trong danh sách loại trừ). Bị loại trừ thì mọi tính năng của hệ thống trí nhớ đều ngừng hoạt động.
 * Khớp theo "tên": các thẻ trùng tên sẽ bị loại trừ cùng lúc —— phù hợp với mong muốn "loại trừ cả loạt thẻ trùng tên này" của người dùng.
 */
export function isCurrentChatExcluded(): boolean {
  if (!apiSettings.excludedChars.length) return false;
  const name = currentCharName();
  return name !== null && apiSettings.excludedChars.includes(name);
}

/** Engine có hiệu lực ở cuộc trò chuyện hiện tại hay không: công tắc tổng đang bật và nhân vật hiện tại không bị loại trừ. Cổng chắn của các tính năng thống nhất đi qua hàm này. */
export function engineActiveHere(): boolean {
  return apiSettings.enabled && !isCurrentChatExcluded();
}

export function getChannelForTask(task: TaskType): ApiChannel | null {
  const id = apiSettings.assignments[task];
  if (!id) return null;
  return apiSettings.channels.find(c => c.id === id) ?? null;
}

/**
 * Phân giải điểm cuối thực tế được sử dụng của một vai trò vector (url/key/model).
 * **Mô hình** của ba vai trò **độc lập với nhau** (mô hình embedding/rerank/query vốn dĩ khác nhau), không bao giờ tái sử dụng;
 * thứ duy nhất có thể tái sử dụng là **địa chỉ và khóa**: khi url/key của rerank/queryRewrite để trống, sẽ lần lượt lùi về dùng của embedding.
 */
export function resolveVectorModel(role: 'embedding' | 'rerank' | 'queryRewrite'): VectorEndpoint {
  const v = apiSettings.vector;
  const base = v.embedding;
  if (role === 'embedding') return { ...base };
  const cfg = v[role];
  return {
    url: cfg.url.trim() || base.url, // Địa chỉ để trống → tái sử dụng địa chỉ embedding
    key: cfg.key.trim() || base.key, // Khóa để trống → tái sử dụng khóa embedding
    model: cfg.model, // Mô hình luôn độc lập, không lùi về
    timeoutSec: cfg.timeoutSec, // Quá thời gian / thử lại luôn độc lập, không lùi về (mặc định của các vai trò vốn đã khác nhau)
    retries: cfg.retries,
  };
}
