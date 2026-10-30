import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceUrl = new URL('../src/memory/timeRel.ts', import.meta.url);
const sourcePath = fileURLToPath(sourceUrl);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  fileName: sourcePath,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    strict: true,
  },
});

const compileErrors = (transpiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
if (compileErrors.length) {
  const host = {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  };
  throw new Error(ts.formatDiagnosticsWithColorAndContext(compileErrors, host));
}

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`;
const {
  calculateRelativeDays,
  parseStoryDate,
  relativeTimeLabel,
  weekdayLabel,
} = await import(moduleUrl);

let assertions = 0;

function equal(actual, expected, message) {
  assertions++;
  assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
  assertions++;
  const normalize = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(normalize(actual), normalize(expected), message);
}

function standard(year, month, day, calendarPrefix) {
  return {
    year,
    month,
    day,
    type: 'standard',
    ...(calendarPrefix ? { calendarPrefix } : {}),
  };
}

// Định dạng sẵn có của ngày tháng bằng số.
const numericDates = [
  ['2024/9/30', standard(2024, 9, 30)],
  ['2024-9-30', standard(2024, 9, 30)],
  ['2024.9.30', standard(2024, 9, 30)],
  ['2024\uff0e9\uff0e30', standard(2024, 9, 30)],
  ['2024\u30029\u300230', standard(2024, 9, 30)],
  ['2024\ufe529\ufe5230', standard(2024, 9, 30)],
  ['2024/09/03 08:30', standard(2024, 9, 3)],
  ['9/30', { month: 9, day: 30, type: 'standard' }],
  ['09-03 08:30', { month: 9, day: 3, type: 'standard' }],
  ['9.30 ', { month: 9, day: 30, type: 'standard' }],
];
for (const [input, expected] of numericDates) {
  deepEqual(parseStoryDate(input), expected, `Phân tích ngày tháng bằng số thất bại: ${input}`);
}

// Tích Descartes của các dấu phân cách giữa đơn vị năm/tháng/ngày, bao phủ 26 × 26 = 676 tổ hợp.
const acceptedSeparators = [
  '',
  ' ',
  '  ',
  '\t',
  '\n',
  '·',
  ' · ',
  '・',
  '•',
  '‧',
  '∙',
  '⋅',
  '.',
  '．',
  '。',
  '﹒',
  '/',
  '／',
  ',',
  '，',
  '、',
  '_',
  '-',
  '—',
  '–',
  '－',
];
const ERA_PREFIX = '\u5143\u4f1a\u5386\u00b7';
const U_YEAR = '\u5e74';
const U_MONTH = '\u6708';
const U_DAY = '\u65e5';
for (const yearMonthSep of acceptedSeparators) {
  for (const monthDaySep of acceptedSeparators) {
    const input = `${ERA_PREFIX}3727${U_YEAR}${yearMonthSep}9${U_MONTH}${monthDaySep}30${U_DAY} 16:30`;
    deepEqual(
      parseStoryDate(input),
      standard(3727, 9, 30, ERA_PREFIX),
      `Phân tích dấu phân cách có kỷ nguyên thất bại: ${JSON.stringify(input)}`,
    );
  }
}

// Chữ số Ả Rập, chữ số cổ phong/tiếng Việt, mùng âm lịch, viết tắt 20/30.
const unitDates = [
  [`3727${U_YEAR}9${U_MONTH}30${U_DAY}`, standard(3727, 9, 30)],
  [`3727 ${U_YEAR} 9 ${U_MONTH} 30 ${U_DAY}`, standard(3727, 9, 30)],
  [`3727${U_YEAR}·9${U_MONTH}·30${U_DAY}`, standard(3727, 9, 30)],
  [`${ERA_PREFIX}3727${U_YEAR}·9${U_MONTH}30${U_DAY}`, standard(3727, 9, 30, ERA_PREFIX)],
  ['\u5143\u6301\u5341\u4e8c\u5e74\u516b\u6708\u4e8c\u5341\u4e00\u65e5', standard(12, 8, 21, '\u5143\u6301')],
  ['\u6c38\u548c\u5341\u4e94\u5e74\u516b\u6708\u521d\u4e03', standard(15, 8, 7, '\u6c38\u548c')],
  ['\u5e86\u5386\u5341\u5e74\u5341\u6708\u521d\u5341', standard(10, 10, 10, '\u5e86\u5386')],
  ['\u4e24\u5e74\u4e8c\u6708\u4e8c\u65e5', standard(2, 2, 2)],
  ['\u5eff\u5e74·\u5eff\u6708·\u4e00\u65e5', null],
  ['\u5eff\u5e74\u5341\u4e8c\u6708\u5eff\u4e00\u65e5', standard(20, 12, 21)],
  ['\u5345\u5e74\u5341\u4e8c\u6708\u5345\u4e00\u65e5', standard(30, 12, 31)],
  ['\u4e5d\u6708\u4e09\u5341\u65e5', { month: 9, day: 30, type: 'standard' }],
  ['\u4e5d\u6708·\u521d\u4e03', { month: 9, day: 7, type: 'standard' }],
  [`9 ${U_MONTH}／30 ${U_DAY} 16:30`, { month: 9, day: 30, type: 'standard' }],
  ['Ngày 30 tháng 9 năm 3727', standard(3727, 9, 30)],
  ['Lịch Nguyên Hội·Năm 3727 tháng 9 ngày 30', standard(3727, 9, 30, 'Lịch Nguyên Hội·')],
  ['Ngày 30 tháng 9 16:30', { month: 9, day: 30, type: 'standard' }],
];
for (const [input, expected] of unitDates) {
  deepEqual(parseStoryDate(input), expected, `Phân tích ngày tháng có đơn vị thất bại: ${input}`);
}

// Dấu ngoặc thứ trong tuần và các hậu tố thời gian phổ biến không được làm thay đổi phần ngày tháng.
const suffixDates = [
  `${ERA_PREFIX}3727${U_YEAR}·9${U_MONTH}30${U_DAY} 16:30`,
  `${ERA_PREFIX}3727${U_YEAR}·9${U_MONTH}30${U_DAY} 16：30`,
  `${ERA_PREFIX}3727${U_YEAR}·9${U_MONTH}30${U_DAY} \u4e0b\u5348\u56db\u65f6`,
  `${ERA_PREFIX}3727${U_YEAR}·9${U_MONTH}30${U_DAY}(\u4e09) 16:30`,
  `${ERA_PREFIX}3727${U_YEAR}·9${U_MONTH}30${U_DAY} （Bắt đầu chính văn）`,
];
for (const input of suffixDates) {
  deepEqual(parseStoryDate(input), standard(3727, 9, 30, ERA_PREFIX), `Phân tích hậu tố ngày tháng thất bại: ${input}`);
}

// Khi có năm rõ ràng nhưng năm-tháng-ngày đầy đủ không hợp lệ thì bắt buộc phải đóng thất bại, không được lén hạ cấp thành tháng M ngày D.
const malformedExplicitYears = [
  `${ERA_PREFIX}3727${U_YEAR}★9${U_MONTH}30${U_DAY}`,
  `3727${U_YEAR}:9${U_MONTH}30${U_DAY}`,
  `3727${U_YEAR}\u79cb9${U_MONTH}30${U_DAY}`,
  `3727${U_YEAR}9${U_MONTH}`,
  `3727${U_YEAR}0${U_MONTH}30${U_DAY}`,
  `3727${U_YEAR}13${U_MONTH}30${U_DAY}`,
  `3727${U_YEAR}9${U_MONTH}0${U_DAY}`,
  `3727${U_YEAR}9${U_MONTH}32${U_DAY}`,
  '\u4e8c\u3007\u4e8c\u56db\u5e74\u4e5d\u6708\u4e09\u5341\u65e5',
];
for (const input of malformedExplicitYears) {
  equal(parseStoryDate(input), null, `Năm tường minh không được hạ cấp: ${input}`);
  equal(
    relativeTimeLabel(input, `${ERA_PREFIX}3728${U_YEAR}·2${U_MONTH}1${U_DAY} 08:00`),
    '',
    `Năm tường minh không hợp lệ không được sinh thời gian tương đối: ${input}`,
  );
}

// Kịch bản hồi quy chính xác do người dùng báo cáo, cùng các cách viết đồng cấu với mọi dấu phân cách được hỗ trợ.
equal(
  calculateRelativeDays(`${ERA_PREFIX}3727${U_YEAR}·9${U_MONTH}30${U_DAY} 16:45`, `${ERA_PREFIX}3728${U_YEAR}·2${U_MONTH}1${U_DAY} 08:00`),
  124,
  'Sai chiều số ngày qua năm',
);
equal(
  relativeTimeLabel(`${ERA_PREFIX}3727${U_YEAR}·9${U_MONTH}30${U_DAY} 16:45`, `${ERA_PREFIX}3728${U_YEAR}·2${U_MONTH}1${U_DAY} 08:00`),
  '4 tháng trước',
  'Kịch bản người dùng báo cáo phải là 4 tháng trước',
);
equal(
  relativeTimeLabel(`${ERA_PREFIX}3728${U_YEAR}·2${U_MONTH}1${U_DAY} 08:00`, `${ERA_PREFIX}3727${U_YEAR}·9${U_MONTH}30${U_DAY} 16:45`),
  '4 tháng sau',
  'Sai tính toán ngược kịch bản người dùng báo cáo',
);
for (const separator of acceptedSeparators) {
  const event = `${ERA_PREFIX}3727${U_YEAR}${separator}9${U_MONTH}${separator}30${U_DAY} 16:45`;
  const now = `${ERA_PREFIX}3728${U_YEAR}${separator}2${U_MONTH}${separator}1${U_DAY} 08:00`;
  equal(calculateRelativeDays(event, now), 124, `Sai số ngày qua năm theo dấu phân cách: ${JSON.stringify(separator)}`);
  equal(relativeTimeLabel(event, now), '4 tháng trước', `Sai nhãn qua năm theo dấu phân cách: ${JSON.stringify(separator)}`);
}

// Biên ngày, tuần, tháng, năm và năm nhuận.
const relativeCases = [
  ['2024/1/1', '2024/1/1', 'Hôm nay'],
  ['2024/1/1', '2024/1/2', 'Hôm qua'],
  ['2024/1/1', '2024/1/3', 'Hôm kia'],
  ['2024/1/1', '2024/1/4', 'Hôm kìa'],
  ['2024/1/2', '2024/1/1', 'Ngày mai'],
  ['2024/1/3', '2024/1/1', 'Ngày kia'],
  ['2024/1/4', '2024/1/1', 'Ngày kìa'],
  ['2023/12/31', '2024/1/1', 'Hôm qua'],
  ['2024/2/28', '2024/3/1', 'Hôm kia'],
  ['2023/2/28', '2023/3/1', 'Hôm qua'],
  ['2024/1/15', '2024/2/20', 'Ngày 15 tháng trước'],
  ['2024/1/1', '2024/4/15', '3 tháng trước'],
  ['2023/6/1', '2024/6/1', 'Ngày 1 tháng 6 năm ngoái'],
  ['2022/6/1', '2024/6/1', 'Ngày 1 tháng 6 năm kia'],
  ['2024/4/15', '2024/1/1', '3 tháng sau'],
];
for (const [event, now, expected] of relativeCases) {
  equal(relativeTimeLabel(event, now), expected, `Sai thời gian tương đối: ${event} -> ${now}`);
}

const dayDiffCases = [
  ['2024/2/28', '2024/3/1', 2],
  ['2023/2/28', '2023/3/1', 1],
  ['2000/2/28', '2000/3/1', 2],
  ['1900/2/28', '1900/3/1', 1],
  ['2023/12/31', '2024/1/1', 1],
  ['2024/1/1', '2023/12/31', -1],
  [`3727${U_YEAR}9${U_MONTH}30${U_DAY}`, `3728${U_YEAR}2${U_MONTH}1${U_DAY}`, 124],
  ['\u5143\u6301\u5341\u4e8c\u5e74\u516b\u6708\u521d\u4e03', '\u5143\u6301\u5341\u4e8c\u5e74\u516b\u6708\u521d\u5341', 3],
];
for (const [from, to, expected] of dayDiffCases) {
  equal(calculateRelativeDays(from, to), expected, `Sai độ lệch ngày: ${from} -> ${to}`);
}

// Tháng hư cấu chỉ cho phép so sánh cùng tháng, khác tháng phải từ bỏ.
const FANTASY_FROST = `\u971c${U_MONTH}`;
const FANTASY_SNOW = `\u96ea${U_MONTH}`;
deepEqual(parseStoryDate(`${FANTASY_FROST}3${U_DAY}`), { monthId: FANTASY_FROST, day: 3, type: 'fantasy', raw: `${FANTASY_FROST}3${U_DAY}` });
equal(relativeTimeLabel(`${FANTASY_FROST}3${U_DAY}`, `${FANTASY_FROST}5${U_DAY}`), 'Hôm kia');
equal(relativeTimeLabel(`${FANTASY_FROST}3${U_DAY}`, `${FANTASY_SNOW}5${U_DAY}`), '');
equal(calculateRelativeDays(`${FANTASY_FROST}3${U_DAY}`, `${FANTASY_SNOW}5${U_DAY}`), null);

// Thứ trong tuần chỉ có hiệu lực với ngày tháng chuẩn có đầy đủ năm và không có tiền tố kỷ nguyên.
equal(weekdayLabel('2024/1/1'), 'Thứ hai');
equal(weekdayLabel(`2024${U_YEAR}·1${U_MONTH}·1${U_DAY}`), 'Thứ hai');
equal(weekdayLabel(`1${U_MONTH}1${U_DAY}`), '');
equal(weekdayLabel(`${ERA_PREFIX}2024${U_YEAR}·1${U_MONTH}·1${U_DAY}`), '');
equal(weekdayLabel(`${FANTASY_FROST}3${U_DAY}`), '');

console.log(`timeRel tests passed: ${assertions} assertions`);
