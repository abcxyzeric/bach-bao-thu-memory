import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiChannel } from '@/api/settings';
import * as context from '@/st/context';
import type { STContext } from '@/st/context';
import { RESUMMARY_THINKING_CHECKLIST } from '@/memory/prompts';
import { buildRequestBody, requestCompletion } from './client';

const channel: ApiChannel = {
  id: 'ch1',
  name: 'Kênh kiểm thử',
  url: 'https://api.example.com',
  key: 'k',
  model: 'm',
  temperature: 1,
  maxTokens: 1024,
  timeoutSec: 60,
  stream: false,
  excludeParams: [],
  reasoningEffort: '',
};

describe('buildRequestBody: cường độ suy nghĩ và hai nhánh nguồn', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const build = (over: Partial<ApiChannel> = {}) =>
    buildRequestBody({ ...channel, ...over }, msgs, 'https://api.example.com/v1', false);

  it('Chưa đặt cường độ suy nghĩ → đi theo nguồn openai (ngoài tool_choice mới thêm, phần thân yêu cầu giống hệt trước khi thêm tính năng)', () => {
    expect(build()).toEqual({
      chat_completion_source: 'openai',
      reverse_proxy: 'https://api.example.com/v1',
      proxy_password: 'k',
      model: 'm',
      messages: msgs,
      temperature: 1,
      max_tokens: 1024,
      stream: false,
      tool_choice: 'none',
      presence_penalty: 0,
      frequency_penalty: 0,
    });
  });

  it('Cả hai nhánh nguồn đều mang tool_choice:none (bắt tay cho phép qua đối với các bộ chặn fetch chống cắt cụt)', () => {
    // Các bộ chặn như Dramatron thấy bên gọi có sẵn tool_choice sẽ không tiêm công cụ tổng hợp;
    // nếu người dùng thực sự muốn để bên thứ ba viết lại, có thể dùng excludeParams xóa nó đi.
    expect(build().tool_choice).toBe('none');
    expect(build({ reasoningEffort: 'high' }).tool_choice).toBe('none');
    expect(build({ excludeParams: ['tool_choice'] }).tool_choice).toBeUndefined();
  });

  it('Đã đặt cường độ suy nghĩ → chuyển sang nguồn custom, và truyền xuyên qua custom_include_body', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.chat_completion_source).toBe('custom');
    expect(body.custom_url).toBe('https://api.example.com/v1');
    // Tầng cao nhất không gửi reasoning_effort: nguồn openai/custom đều chặn theo danh sách trắng tên mô hình,
    // khi tên mô hình tình cờ khớp sẽ ghi đè mất giá trị chúng ta thực sự muốn gửi
    expect(body.reasoning_effort).toBeUndefined();
    expect(JSON.parse(body.custom_include_body as string)).toEqual({ reasoning_effort: 'high' });
  });

  it('Nguồn custom bắt buộc phải mang key qua header: proxy_password không được đọc dưới nguồn này', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.proxy_password).toBeUndefined();
    expect(JSON.parse(body.custom_include_headers as string)).toEqual({
      Authorization: 'Bearer k',
    });
  });

  it('Khi key chứa siêu ký tự YAML vẫn có thể tiêm an toàn (nhờ JSON.stringify thoát ký tự)', () => {
    // Tự ghép YAML thủ công sẽ phân tích thất bại trên loại key này; còn mergeObjectWithYaml của ST lại bỏ qua âm thầm,
    // tiêm header thất bại → lùi về đọc khóa Custom của chính ST → có thể gửi nhầm key của nơi khác tới điểm cuối này.
    const nasty = 'sk-a:b#c{d}e*f "g"';
    const body = build({ reasoningEffort: 'high', key: nasty });
    expect(JSON.parse(body.custom_include_headers as string).Authorization).toBe(`Bearer ${nasty}`);
  });

  it('Chuỗi khoảng trắng coi như chưa đặt (không chuyển nhầm sang nguồn custom)', () => {
    expect(build({ reasoningEffort: '   ' }).chat_completion_source).toBe('openai');
  });

  it('Giá trị không làm danh sách trắng: giá trị phi tiêu chuẩn truyền xuyên qua nguyên trạng', () => {
    const body = build({ reasoningEffort: 'mức của riêng tôi' });
    expect(JSON.parse(body.custom_include_body as string).reasoning_effort).toBe('mức của riêng tôi');
  });

  it('excludeParams vẫn có hiệu lực bình thường ở cả hai nhánh', () => {
    expect(build({ excludeParams: ['temperature'] }).temperature).toBeUndefined();
    expect(
      build({ excludeParams: ['temperature'], reasoningEffort: 'high' }).temperature,
    ).toBeUndefined();
  });
});

describe('visible compression audit transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([false, true] as const)('keeps the checklist and raw audit (stream=%s)', async stream => {
    vi.spyOn(context, 'getContext').mockReturnValue({
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    } as unknown as STContext);
    const raw = '<thinking>F1 | verified</thinking>{"summary":"Verified facts."}';
    const response = stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: raw } }] })}\n\ndata: [DONE]\n\n`)
      : Response.json({ choices: [{ message: { content: raw } }] });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const messages = [
      { role: 'system' as const, content: 'Task schema and compression rules.' },
      { role: 'user' as const, content: 'Compress the supplied summaries.' },
      { role: 'system' as const, content: RESUMMARY_THINKING_CHECKLIST },
    ];

    expect(await requestCompletion({ ...channel, stream }, messages)).toBe(raw);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    // Đã hủy bỏ điền sẵn: phần thân yêu cầu giữ nguyên từng chữ tin nhắn truyền vào, không còn cắt bỏ assistant ở cuối
    expect(body.messages).toEqual(messages);
    expect(body.messages[0]).toEqual(messages[0]);
    expect(body.messages).toContainEqual({ role: 'system', content: RESUMMARY_THINKING_CHECKLIST });
    expect(messages).toHaveLength(3);
  });
});
