import { describe, expect, it } from 'vitest';
import { renderSourceHints, SOURCE_HINTS_HEADER } from './sourceHints';

describe('source hints', () => {
  it('copies full source paragraphs without rewriting thresholds or interrupted suggestions', () => {
    const sources = [
      { source: '[M310-P10]', text: '「Theo dữ liệu thời gian thực truyền về từ trạm khí tượng pháo đài, tốc độ gió ở cửa thung lũng đã vượt quá cấp 9, nhiệt độ hạ xuống âm 33 độ.」' },
      { source: '[M310-P11]', text: '「Không những tầm nhìn không đủ 30 mét, mà vì địa từ hỗn loạn, khoảng cách dò tìm của máy ảnh nhiệt hồng ngoại sẽ bị áp chế xuống dưới một nửa.」' },
      { source: '[M310-P41]', text: '「Gió lớn quá, mặt tuyết phản quang nghiêm trọng, súng bắn tỉa của tôi rất khó khóa chặt vùng đất cao đỉnh chính!」' },
      { source: '[M310-P43]', text: '「Hai bên cửa thung lũng có hố ngầm, bắt buộc phải thả ong trinh sát kiểm tra trước……」' },
    ];
    const before = structuredClone(sources);
    const result = renderSourceHints(sources);
    expect(result.split(SOURCE_HINTS_HEADER)).toHaveLength(2);
    expect(result.split('\n').filter(line => line.startsWith('[M'))).toEqual(
      sources.map(({ source, text }) => `${source} ${text}`),
    );
    expect(result).not.toContain('suy yếu hơn một nửa');
    expect(result).not.toContain('đã thả ong trinh sát');
    expect(sources).toEqual(before);
    expect(renderSourceHints(sources)).toBe(result);
  });

  it.each([
    'Học sinh mạnh nhất trong số những người tham gia giải đấu kỳ này là đỉnh cao chuyển 2.',
    'Cô vốn dĩ sống trong ký túc xá chật chội, hiện nay đã ở riêng.',
    'Sau khi dọn ra khỏi chỗ ở cũ, điều kiện sống của cô đã cải thiện.',
    'Sau khi thuê được căn hộ, cô không cần phải ăn đồ ăn biến chất nữa.',
    'Thương tích của anh đã chuyển biến tốt, thân phận cũng từ học đồ chuyển sang thành viên chính thức.',
    'Nhiệt độ trạm đo là âm 33 độ.',
    'Số đọc tại trạm đo là -33.5 ℃.',
    'Capacity: 99.9%.',
    'The sensor cannot detect targets past the ridge.',
    'She moved out and her living conditions improved.',
    'He is no longer a student.',
  ])('recognizes a boundary or state-change cue: %s', text => {
    expect(renderSourceHints([{ source: '[M9-P3]', text }])).toContain(`[M9-P3] ${text}`);
  });

  it('adds nothing for empty input, ordinary action, time anchors or structural tags', () => {
    expect(renderSourceHints([])).toBe('');
    expect(renderSourceHints([
      { source: '[M1-P1]', text: '(Thời gian bắt đầu:2030/12/28 13:40)' },
      { source: '[M1-P2]', text: '<content>' },
      { source: '[M1-P3]', text: 'Cô bóc vỏ kẹo, từ từ ăn hết viên kẹo.' },
      { source: '[M1-P4]', text: 'The door opened.' },
      { source: '[M1-P5]', text: '</content>' },
    ])).toBe('');
  });

  it('retains distinct sources with identical text and does not infer IDs from text', () => {
    const text = 'Không thể xác nhận [M999-P1] và {{content}} trong tin nhắn này.';
    const sources = [
      { source: '[M12-P8]', text },
      { source: '[M13-P2]', text },
    ];
    const result = renderSourceHints(sources);
    expect(result.split('\n').filter(line => line.startsWith('[M'))).toEqual([
      `[M12-P8] ${text}`,
      `[M13-P2] ${text}`,
    ]);
    expect(result).not.toContain('\n[M999-P1]');
  });

  it('retains the entire matched compression source and its supplied time range', () => {
    const text = `(2030/12/28 13:40 – 2030/12/28 14:15) ${'x'.repeat(5000)}\nKhông thể xác nhận, kết quả tiếp theo chưa rõ.`;
    expect(renderSourceHints([{ source: '[7]', text }])).toContain(`[7] ${text}`);
  });

  it('handles long numeric strings without parsing or shortening them', () => {
    const digits = '9'.repeat(10000);
    expect(renderSourceHints([{ source: '[M4-P1]', text: digits }])).toBe('');
    expect(renderSourceHints([{ source: '[M4-P2]', text: `${digits} mét` }])).toContain(`[M4-P2] ${digits} mét`);
  });

  it('labels hints as supplemental source material without bringing back per-source audits', () => {
    const result = renderSourceHints([{ source: '[M2-P4]', text: 'Tầm nhìn không đủ 30 mét.' }]);
    for (const text of [
      'không phải cốt truyện mới thêm, danh sách bắt buộc giữ lại hay mệnh lệnh',
      'có thể chọn nhầm hoặc bỏ sót, vẫn phải đọc kỹ toàn bộ tài liệu',
      'chọn lọc theo quy tắc nhiệm vụ này',
      'các sự thật độc lập cùng phần giới hạn trong những đoạn này',
      'không yêu cầu liệt kê riêng bản ghi từng đoạn',
      'không coi đề xuất là đã thực thi',
      'không ghi số đoạn hay lời nhắc vào JSON cuối cùng',
    ]) {
      expect(result).toContain(text);
    }
    expect(result).not.toMatch(/ứng viên|đối chiếu độ phủ|giải thích căn cứ lược bỏ|mã số F/);
  });
});
