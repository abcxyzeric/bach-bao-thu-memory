import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import {
  buildBatchSummaryPrompt,
  buildBatchThinking,
  buildCharCardSystem,
  buildPersonaSystem,
  buildResummaryPrompt,
  buildSummaryPrompt,
  buildSummaryThinking,
  buildWorldInfoSystem,
  JAILBREAK_PROMPT,
  isBuiltinSummaryPrompt,
  LEDGER_PROTOCOL,
  MEMORY_BRIEFING_END,
  MEMORY_BRIEFING_NOTE,
  QUERY_REWRITE_SYSTEM,
  QUERY_REWRITE_TAIL,
  RESUMMARY_PROMPT,
  RESUMMARY2_PROMPT,
  RESUMMARY_THINKING_CHECKLIST,
  RULE_ABSOLUTE_TIME_LANGUAGE,
  RULE_NPC_AFFINITY,
  RULE_PROTAGONIST,
  RULE_RELATION_MOMENTUM,
  RULE_SCENE_FOCUS,
  SUMMARY_MACROS,
  SUMMARY_OUTPUT_PROTOCOL,
  SUMMARY_PROMPT,
  THINKING_CHECKLIST,
} from './prompts';
import { START_TAG, TIME_TAG_PROMPT } from './timeTag';
import dataWrappersRaw from './prompts/data-wrappers.txt?raw';

const originalPrompts = { ...apiSettings.prompts };
const originalVerbosity = apiSettings.verbosity;

beforeEach(() => {
  Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
});

afterEach(() => {
  Object.assign(apiSettings.prompts, originalPrompts);
  apiSettings.verbosity = originalVerbosity;
});

const args: Parameters<typeof buildSummaryPrompt>[0] = {
  user: 'User',
  char: 'Character',
  time: '2026/9/8 10:00',
  location: 'School',
  protagonist: {},
  sceneFocus: null,
  lifeDetails: [],
  items: [],
  itemLog: [],
  scenes: [],
  npcs: [],
  openPlans: [],
  resolvedPlans: [],
  history: 'Earlier events.',
  content: 'The current passage.',
  hasTimeTags: true,
  varsState: {},
  varsMeaning: '',
  varsRule: '',
};

function combined(parts: ReturnType<typeof buildSummaryPrompt>): string {
  return `${parts.system}\n\n${parts.user}`;
}

describe('new built-in prompts', () => {
  it('ships the fact-preservation rules (Lõi tập trung ở vượt giới hạn, chính văn không mang lặp lại nữa)', () => {
    const parts = buildSummaryPrompt(args);
    const system = parts.system;
    // Lõi NVWA phải tập trung trong JAILBREAK_PROMPT (chiếm vị trí system độc lập), không còn xuất hiện trong chính văn
    expect(JAILBREAK_PROMPT).toContain('<nvwa_standalone_core>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_adult_content>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_safety_guardrails>');
    expect(system).not.toContain('<nvwa_standalone_core>');
    expect(system).toContain('【Quy tắc vật phẩm】(trường items, sàng lọc nghiêm ngặt)');
    expect(system).toContain('【Quy tắc NPC】(trường npcs, sàng lọc cực kỳ nghiêm ngặt)');
    expect(system).toContain('【Quy tắc kế hoạch/nghi vấn】(trường plans)');
    expect(system).toContain('【Quy tắc bối cảnh/địa điểm】(trường scenes, chỉ ghi những địa điểm có tên đã từng đến)');
    expect(system).toContain('【Trình tự viết tóm tắt】');
    expect(system).toContain('【Ranh giới sự thật không gian】');
    expect(system).toContain('【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】');
    expect(system).toContain('【Quy tắc viết tóm tắt】(trường summary, bắt buộc điền)');
    // Giao thức mã số thương tích đã ngừng sử dụng: trạng thái đổi lại thành ghi đè toàn văn giống như trang phục
    expect(system).not.toContain('【Giao thức cập nhật cục bộ tình trạng thương tích】');
    expect(system).not.toContain('conditionPatch');
    // Cửa ải cứng về bằng chứng định vị NPC đã gỡ bỏ: khi câu trích dẫn không khớp nguyên văn sẽ âm thầm làm mất định vị hợp lệ
    expect(system).not.toContain('locationEvidence');
    // Phần sót lại quên xóa khi gỡ bản vá thương tích: mô hình sẽ đi tìm「giao thức cục bộ」vốn không còn tồn tại
    expect(system).not.toContain('giao thức cục bộ');
    // qty bắt buộc điền + số lượng không rõ không đoán từng tạo thành thế bí, những thứ không đếm xuể chỉ đành không ghi
    expect(system).toContain('ghi một phần theo bao bì');
    // Ví dụ minh họa bầu không khí của thẻ cục diện từng bị xóa, khiến tấm thẻ thoái hóa thành bản ghi động tác khô khan
    expect(system).toContain('Cốt truyện bầu bạn/đời thường thì viết bầu không khí tương tác');
    // Khi văn phong chỉ có lệnh cấm và ví dụ toàn giọng văn hành chính, cảnh đời thường dễ bị viết thành biên bản hoặc xóa sạch tương tác
    expect(system).toContain('(tương tác bị xóa sạch)');
    // Lệnh cấm bầu không khí từng viết cứng nhắc, khiến bầu không khí được viết rõ trong nguyên văn cũng bị xóa theo
    expect(system).toContain('bầu không khí được viết rõ trong nguyên văn thì có thể giữ lại theo đúng nguyên ý');
    // Ví dụ điền bảng từng yêu cầu「xưng hô + một câu thái độ」, mâu thuẫn với quy tắc, khiến thái độ ấn tượng đầu tiên bị đóng băng vào relation vốn chỉ sửa khi biến đổi về chất
    expect(system).not.toContain('xưng hô ở trước + một câu thái độ');
    expect(system).toContain('không tự bù thái độ chỉ để cho đủ định dạng');
    expect(LEDGER_PROTOCOL).toContain('bbs_items');
  });

  it('keeps the material in user and the rules in system, with all macros expanded', () => {
    const parts = buildSummaryPrompt({
      ...args,
      protagonist: { identity: 'PROFILE_SENTINEL' },
      history: 'HISTORY_SENTINEL',
      varsState: { value: 'VARIABLE_SENTINEL' },
      varsMeaning: 'MEANING_SENTINEL',
      varsRule: 'VARIABLE_RULE_SENTINEL',
      content: 'BODY_SENTINEL',
    });
    const thinking = buildSummaryThinking(args.user);
    for (const sentinel of ['PROFILE_SENTINEL', 'HISTORY_SENTINEL', 'VARIABLE_SENTINEL', 'MEANING_SENTINEL', 'VARIABLE_RULE_SENTINEL', 'BODY_SENTINEL']) {
      expect(parts.user).toContain(sentinel);
      expect(parts.system + thinking).not.toContain(sentinel);
    }
    expect(parts.user).toContain('【Đối thoại lượt này】');
    for (const text of [parts.system, parts.user, thinking]) {
      expect(text).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('fills the summary word range and the character cap per verbosity', () => {
    for (const verbosity of ['detailed', 'concise'] as const) {
      apiSettings.verbosity = verbosity;
      const prompt = combined(buildSummaryPrompt(args));
      expect(prompt).toContain(verbosity === 'detailed' ? '150-300' : '80-150');
      expect(prompt).toContain(verbosity === 'detailed' ? '360' : '180');
    }
    expect(SUMMARY_MACROS.map(m => m.token)).toContain('{{summary_max_chars}}');
    // Khoảng số chữ dễ bị coi là nhiệm vụ phải viết cho đủ; cố ý không khôi phục câu「thà ngắn hơn rõ rệt so với mức trần」, tránh để bản tóm tắt tầng đáy ngày càng mỏng
    expect(buildSummaryPrompt(args).system).toContain('Không có nhiệm vụ dung lượng tối thiểu');
  });

  it('keeps custom templates in user with the compatibility supplements in system', () => {
    apiSettings.prompts.summary = 'CUSTOM {{content}} {{protagonist_block}}';
    const parts = buildSummaryPrompt({ ...args, protagonist: { identity: 'CUSTOM_PROFILE' } });
    expect(parts.user).toContain(`CUSTOM ${args.content}`);
    expect(parts.user).toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain(args.content);
    expect(parts.system).toContain('【Giao thức tương thích hồ sơ nhân vật chính của Bách Bảo Thư】');
    // Đoạn bổ sung cắt từ summary.txt, hễ đổi tiêu đề sẽ âm thầm bị cắt thành chuỗi rỗng
    expect(parts.system).toContain('【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】');
    // Phần bổ sung nhân vật chính/thẻ cục diện vốn là chép tay, tụt hậu so với bản tích hợp sẵn và thiếu bằng chứng thương tích cùng quy chuẩn thẻ cục diện; sau khi cắt trực tiếp thì dùng chung một bản với tích hợp sẵn
    expect(parts.system).toContain('【Thương tích tạm thời và bằng chứng hồi phục】');
    expect(parts.system).toContain('Cục diện khi kết thúc tầng này');
    // Đính chính tình trạng thương tích chỉ dành cho mẫu v0.17 hướng dẫn conditionPatch, các mẫu khác không cần thêm đoạn này
    expect(parts.system).not.toContain('【Đính chính cách viết tình trạng thương tích của Bách Bảo Thư】');
    expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
  });

  it('does not re-append the time rule a custom template already carries', () => {
    // Mẫu cũ thường có sẵn quy tắc thép bản cũ, nếu bổ sung thêm bản mới sẽ khiến hai quy chuẩn cùng tồn tại
    apiSettings.prompts.summary = 'CUSTOM 【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】 {{content}}';
    expect(buildSummaryPrompt(args).system).not.toContain('【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】');
  });

  it('still appends the time rule when only the expanded {{time_rule}} mentions it', () => {
    // Khi không có thẻ thời gian, quy tắc thời gian do {{time_rule}} triển khai có nhắc tới tên quy tắc thép, không được coi là mẫu có sẵn mà bỏ sót việc bổ sung
    apiSettings.prompts.summary = 'CUSTOM {{time_rule}} {{content}}';
    const parts = buildSummaryPrompt({ ...args, hasTimeTags: false });
    expect(parts.user).toContain('không chịu sự hạn chế "lời trần thuật không tự bù năm, phút" của【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】');
    expect(parts.system).toContain('═══ 【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】');
  });

  it('does not repeat sections a template copied from the default already carries', () => {
    // Mẫu sửa từ bản tích hợp sẵn đã có sẵn toàn bộ các mục quy tắc, bổ sung thêm sẽ thành gửi cùng một quy tắc hai lần; khi system rỗng thì engine sẽ bỏ qua
    apiSettings.prompts.summary = `${SUMMARY_PROMPT}\n(Tùy chỉnh)`;
    const parts = buildSummaryPrompt({ ...args, knowledge: [{ id: 'know:t#0', subject: 'Character', text: 'Khẳng định nhân vật chính là thương buôn', createdAt: 1 }] });
    expect(parts.system).toBe('');
    for (const title of ['Quy tắc hồ sơ hiện tại của nhân vật chính', 'Quy tắc thẻ cục diện tương tác', 'Quy tắc hồ sơ đời sống', 'Quy tắc danh sách hiểu biết', 'Quy tắc hảo cảm nội tâm và thái độ bên ngoài', 'Giữ lại mạch quan hệ', 'Quy tắc thép về ngôn ngữ thời gian trong tóm tắt']) {
      expect(combined(parts).split(`═══ 【${title}】`)).toHaveLength(2);
    }
  });

  it('corrects the retired conditionPatch for templates copied from v0.17', () => {
    // Mẫu mặc định v0.17 hướng dẫn bản vá thương tích đã ngừng sử dụng: viết theo nó sẽ bị tầng làm sạch loại bỏ, khiến thương tích của nhân vật chính và NPC đều không cập nhật được.
    // Nó đã có sẵn mục nhân vật chính và chỉ khác ở cách viết thương tích, bổ sung một câu đính chính là đủ; gửi lại cả đoạn quy tắc nhân vật chính sẽ khiến cả hai cách viết cũ mới cùng tồn tại
    apiSettings.prompts.summary = 'CUSTOM ═══ 【Quy tắc hồ sơ hiện tại của nhân vật chính】 conditionPatch {{content}}';
    const system = buildSummaryPrompt(args).system;
    expect(system).toContain('【Đính chính cách viết tình trạng thương tích của Bách Bảo Thư】');
    expect(system).toContain('`condition` của nhân vật chính và NPC nhất loạt ghi đè toàn đoạn');
    expect(system).not.toContain('【Giao thức tương thích hồ sơ nhân vật chính của Bách Bảo Thư】');
  });

  it('slices exactly one section for each shared rule', () => {
    // Cắt theo tiêu đề: đổi tên tiêu đề sẽ cắt thành chuỗi rỗng, chèn mục mới vào giữa hai tiêu đề sẽ âm thầm bị mang đi cùng
    for (const [rule, title] of [
      [RULE_PROTAGONIST, '【Quy tắc hồ sơ hiện tại của nhân vật chính】'],
      [RULE_SCENE_FOCUS, '【Quy tắc thẻ cục diện tương tác】'],
      [RULE_RELATION_MOMENTUM, '【Giữ lại mạch quan hệ】'],
      [RULE_ABSOLUTE_TIME_LANGUAGE, '【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】'],
      [RULE_NPC_AFFINITY, '【Quy tắc hảo cảm nội tâm và thái độ bên ngoài】'],
    ]) {
      expect(rule.startsWith(`═══ ${title}`)).toBe(true);
      expect(rule.match(/═══/g)).toHaveLength(2);
      expect(rule).not.toMatch(/\{\{\w+_rule\}\}/);
    }
  });

  it('isBuiltinSummaryPrompt phân biệt tích hợp sẵn/tùy chỉnh', () => {
    expect(isBuiltinSummaryPrompt()).toBe(true);
    Object.assign(apiSettings.prompts, { summary: SUMMARY_PROMPT });
    expect(isBuiltinSummaryPrompt()).toBe(true);
    apiSettings.prompts.summary = 'Tùy chỉnh {{content}}';
    expect(isBuiltinSummaryPrompt()).toBe(false);
  });

  it('sends the current output protocol in the checklist, not the schema system block', () => {
    const parts = buildSummaryPrompt(args);
    expect(combined(parts)).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(THINKING_CHECKLIST).toContain('【Kiểm tra trước khi xuất】');
    expect(THINKING_CHECKLIST).not.toContain('conditionPatch');
    // Danh sách v0.17 bị sót mục địa điểm, mô hình thường không ghi vị trí cả tầng
    expect(THINKING_CHECKLIST).toContain('Định vị tầng này');
    // Kiểm điểm các trường cũng từng bị cắt bớt, NPC/vật phẩm thường sót tạo mới hoặc sót cập nhật, thẻ cục diện cứ treo mãi cảnh cũ
    for (const item of ['Kiểm điểm nhân vật chính', 'Kiểm điểm NPC', 'Kiểm điểm cục diện', 'Kiểm điểm vật phẩm', 'Kiểm điểm hồ sơ đời sống', 'Kiểm điểm kế hoạch/nghi vấn']) expect(THINKING_CHECKLIST).toContain(item);
    // Khi chỉ còn「đối chiếu kế hoạch cũ」, nghi vấn đã sáng tỏ cũng không ai kết án
    expect(THINKING_CHECKLIST).toContain('Rà soát từng nghi vấn cũ');
    // Danh sách hiểu biết được thêm muộn hơn danh sách kiểm tra, trước giờ không có mục kiểm điểm nên khi nhân vật biết chuyện riêng của nhân vật chính dễ bị bỏ sót; khi tắt tính năng thì cả mục không xuất hiện
    expect(buildSummaryThinking(args.user, true)).toContain(`ở tầng này có ai tận tai nghe thấy, tận mắt nhìn thấy hoặc nghe người khác kể lại về tên`);
    expect(buildSummaryThinking(args.user)).not.toContain('Danh sách hiểu biết');
    // Từng yêu cầu nhân vật mới nhất loạt phải kèm location hoặc follow, khiến nhân vật liên lạc từ xa hoặc chưa lộ diện bị ép phải bịa vị trí
    expect(THINKING_CHECKLIST).not.toContain('location hoặc follow');
    expect(THINKING_CHECKLIST).toContain('nhân vật chỉ được nhắc tới hoặc liên lạc từ xa mà không nói rõ nơi ở thì lược bỏ `location`');
    expect(buildSummaryThinking(args.user)).toContain(args.user);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('khóa gốc chỉ gồm `summary`');
  });

  it('treats a saved exact default as built-in while keeping the editor copy complete', () => {
    const before = [
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ];
    Object.assign(apiSettings.prompts, { summary: SUMMARY_PROMPT, resummary: RESUMMARY_PROMPT, resummary2: RESUMMARY2_PROMPT });
    expect([
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ]).toEqual(before);
    for (const template of [SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT]) {
      expect(template).toContain('{{content}}');
      expect(template).toContain(SUMMARY_OUTPUT_PROTOCOL);
    }
  });
});

describe('batch and compression prompts', () => {
  it('keeps batch floor boundaries, count macros and the summary-only protocol', () => {
    const parts = buildBatchSummaryPrompt({ ...args, floorCount: 3 });
    const prompt = combined(parts);
    const thinking = buildBatchThinking(3);
    expect(thinking).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(thinking).toContain('Đợt này có tổng cộng 3 tầng');
    expect(thinking).toContain('Mỗi phần tử chỉ chứa `n` / `summary` / `timeStart` / `timeEnd`');
    expect(thinking).toContain('Cả hai đầu mút của ngày tháng hiện đại/dạng số đều bắt buộc phải bao gồm đầy đủ năm');
    expect(parts.system).toContain('độ dài bắt buộc phải bằng 3');
    // Quy tắc viết được cắt từ mẫu đơn tầng, hai bên không còn viết riêng hai bộ; đoạn cắt ra không được mang theo trường dành riêng cho đơn tầng
    expect(parts.system).toContain('【Quy tắc viết tóm tắt】(trường summary, bắt buộc điền)');
    expect(parts.system).toContain('【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】');
    // Ví dụ cảnh đời thường được viết trong quy tắc viết, tóm tắt hàng loạt đồng bộ theo đoạn cắt, không chép riêng một bản
    expect(parts.system).toContain('(tương tác bị xóa sạch)');
    expect(parts.system).not.toContain('sceneFocus');
    expect(parts.user).toContain(args.content);
    expect(parts.system).not.toContain(args.content);
    expect(prompt + thinking).not.toMatch(/\{\{\w+\}\}/);
  });

  it('emits the compression schema with budgets and keeps sources in user', () => {
    for (const level of [1, 2] as const) {
      const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level });
      expect(parts.system).toContain('{ "summary":');
      expect(parts.user).toContain('x'.repeat(1000));
      expect(parts.system).not.toContain('x'.repeat(1000));
      expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
      expect(combined(parts)).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    }
    expect(combined(buildResummaryPrompt({ ...args, level: 1 }))).toContain('【Giữ lại mạch quan hệ】');
    expect(combined(buildResummaryPrompt({ ...args, level: 2 }))).toContain('【Ranh giới bằng chứng sự thật (Ưu tiên cao nhất)】');
  });

  it('keeps custom compression text in user and supplements in system', () => {
    apiSettings.prompts.resummary = 'CUSTOM L1 {{content}} {{resummary_words}}';
    apiSettings.prompts.resummary2 = 'CUSTOM L2 {{content}} {{target_min}} {{target_max}} {{target}}';
    for (const level of [1, 2] as const) {
      const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level });
      expect(parts.user).toContain(level === 1 ? 'CUSTOM L1' : 'CUSTOM L2');
      expect(parts.system).not.toContain(level === 1 ? 'CUSTOM L1' : 'CUSTOM L2');
      expect(parts.system).toContain('【Giữ lại mạch quan hệ】');
      expect(parts.system).toContain('【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】');
      expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('leaves system empty when a custom compression template carries both supplements', () => {
    // Mẫu tùy chỉnh được sửa từ mẫu tích hợp sẵn vốn đã có sẵn cả hai đoạn; engine sẽ bỏ qua system rỗng
    apiSettings.prompts.resummary = '【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】【Giữ lại mạch quan hệ】 {{content}}';
    expect(buildResummaryPrompt({ ...args, level: 1 }).system).toBe('');
  });
});

describe('jailbreak, briefing and query rewrite', () => {
  it('replaces the old override with the bare NVWA core (no task note)', () => {
    expect(JAILBREAK_PROMPT).toContain('<nvwa_standalone_core>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_adult_content>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_safety_guardrails>');
    expect(JAILBREAK_PROMPT).not.toContain('【Hướng dẫn nhiệm vụ biên tập ký ức】');
    expect(JAILBREAK_PROMPT).not.toContain('sanctuary_override_directive');
  });

  it('frames the briefing as past-only context that does not cap relationships or set prose style', () => {
    expect(MEMORY_BRIEFING_NOTE).toContain('đừng xuất các nhãn, trường, số thứ tự hoặc cả đoạn văn bản tổng hợp của bản tin này');
    expect(MEMORY_BRIEFING_END).toContain('không phải là giới hạn trần');
    expect(MEMORY_BRIEFING_END).toContain('vị trí và trang phục được xác nhận lần cuối không đảm bảo vẫn còn hiệu lực');
    expect(MEMORY_BRIEFING_END).toContain('đừng bắt chước kiểu câu của bản ghi nén');
  });

  it('Đóng gói tư liệu khớp từng chữ với nguyên văn 09 (chỉ thay chỗ trống bằng tư liệu thực tế)', () => {
    const section = (placeholder: string, sentinel: string) =>
      dataWrappersRaw
        .replace(placeholder, sentinel)
        .split(/\n\s*\n(?=【)/)
        .find(b => b.includes(sentinel))!
        .trim();
    expect(buildPersonaSystem('SENT')).toBe(section('〔Chỗ trống thiết lập nhân vật chính〕', 'SENT'));
    expect(buildWorldInfoSystem('SENT')).toBe(section('〔Chỗ trống nội dung sổ thế giới〕', 'SENT'));
    expect(buildCharCardSystem('SENT')).toBe(section('〔Chỗ trống nội dung thẻ nhân vật〕', 'SENT'));
  });

  it('keeps the original 5-query rewrite prompt (Tái hiện bản tối ưu của người dùng từ Horae)', () => {
    expect(QUERY_REWRITE_SYSTEM).toContain('Bạn là bộ lập kế hoạch ngữ cảnh trong kịch bản viết tiếp nhập vai');
    // Bản gốc yêu cầu “Tạo cố định 5 câu truy vấn” —— truy xuất đa luồng + hợp nhất RRF dựa vào đúng độ bao phủ của 5 câu này
    expect(QUERY_REWRITE_SYSTEM).toContain('Tạo cố định 5 câu truy vấn');
    expect(QUERY_REWRITE_SYSTEM).toContain('INTENT');
    expect(QUERY_REWRITE_SYSTEM).toContain('Ví dụ 1:');
    expect(QUERY_REWRITE_TAIL).toContain('đúng 5 dòng Q');
    expect(QUERY_REWRITE_TAIL).toContain('INTENT');
  });

  it('keeps the time-tag prompt on the anchor-initialising behaviour without the NVWA core', () => {
    expect(TIME_TAG_PROMPT).not.toContain('<nvwa_standalone_core>');
    expect(TIME_TAG_PROMPT).toContain('【Yêu cầu mốc thời gian (Hệ thống bắt buộc)】');
    expect(TIME_TAG_PROMPT).toContain(`<${START_TAG}>`);
    expect(TIME_TAG_PROMPT).toContain('xin bạn tự thiết lập một thời khắc bắt đầu cụ thể phù hợp với thế giới quan này');
    expect(TIME_TAG_PROMPT).toContain('đây là thiết lập hợp lý cần thiết để xây dựng mốc thời gian cho hệ thống trí nhớ, không tính là bịa đặt');
    expect(TIME_TAG_PROMPT).toContain('bbs_items');
  });
});
