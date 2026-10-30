import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

async function importStandalone(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const sourcePath = fileURLToPath(sourceUrl);
  const source = await readFile(sourceUrl, 'utf8');
  const transpiled = ts.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: true,
      verbatimModuleSyntax: true,
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
  return import(moduleUrl);
}

let assertions = 0;
function equal(actual, expected, message) {
  assertions++;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  assertions++;
  assert.deepEqual(actual, expected, message);
}
function includes(text, expected, message) {
  assertions++;
  assert.ok(text.includes(expected), message ?? `Thiếu văn bản: ${expected}`);
}
function occurrence(text, needle, expected, message) {
  const count = text.split(needle).length - 1;
  equal(count, expected, message ?? `Số lần xuất hiện của ${JSON.stringify(needle)} bị sai`);
}

const { mergeProtagonistDelta } = await importStandalone('../src/memory/protagonist.ts');
const { mergeLifeDetailsOp } = await importStandalone('../src/memory/lifeDetails.ts');
const { stripBaiBaiImageTags } = await importStandalone('../src/memory/imageTag.ts');

equal(
  stripBaiBaiImageTags('Dòng thứ nhất\n<bbi_image>tag<size>portrait</size></bbi_image>\nDòng thứ hai'),
  'Dòng thứ nhất\nDòng thứ hai',
  'Thẻ Bách Bảo Hội chiếm riêng một dòng phải xóa kèm LF đứng trước',
);
equal(
  stripBaiBaiImageTags('Dòng thứ nhất\r\n<bbi_image>tag\r\n<nl>scene</nl></bbi_image>\r\nDòng thứ hai'),
  'Dòng thứ nhất\r\nDòng thứ hai',
  'Thẻ Bách Bảo Hội nhiều dòng phải tương thích CRLF',
);
equal(
  stripBaiBaiImageTags('Dòng thứ nhất\n<bbi_image>a</bbi_image>\n<bbi_image>b</bbi_image>\nDòng thứ hai'),
  'Dòng thứ nhất\nDòng thứ hai',
  'Nhiều thẻ Bách Bảo Hội liên tiếp ở cùng vị trí không được để lại dòng trống',
);
equal(
  stripBaiBaiImageTags('Đoạn trước<bbi_image>tag</bbi_image>Đoạn sau'),
  'Đoạn trướcĐoạn sau',
  'Thẻ Bách Bảo Hội viết tay nội tuyến chỉ xóa bản thân thẻ',
);

// Khi tuổi không tham gia bản vá, tuyệt đối không được xóa nhầm mốc neo đã có.
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1', identity: 'Học sinh' }, { identity: 'Giáo viên' }),
  { age: '18', ageTime: '2020/1/1', identity: 'Giáo viên' },
  'Chỉnh sửa trường không phải tuổi không được làm thay đổi mốc neo tuổi',
);

// Người dùng sửa tuổi mà không đưa mốc neo mới tường minh: bắt buộc xóa mốc neo cũ, giao cho lá hiện tại thiết lập lại.
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '25' }),
  { age: '25' },
  'Sau khi sửa tuổi mốc neo cũ không được sót lại',
);

// Khi tuổi không đổi UI sẽ mang trả lại mốc neo gốc một cách tường minh, bắt buộc giữ nguyên.
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '18', ageTime: '2020/1/1' }),
  { age: '18', ageTime: '2020/1/1' },
  'Khi không sửa tuổi phải giữ nguyên mốc neo gốc',
);

// Khi bên gọi như carryover/nhập dữ liệu đưa mốc neo mới tường minh, lấy mốc neo mới làm chuẩn.
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '20', ageTime: '2022/1/1' }),
  { age: '20', ageTime: '2022/1/1' },
  'Mốc neo mới tường minh không được bị xóa',
);

// Xóa trống tuổi bắt buộc xóa luôn cả mốc neo cũ; sau đó điền lại cũng không được làm sống lại mốc neo cũ.
const cleared = mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '' });
deepEqual(cleared, { age: '' }, 'Khi xóa trống tuổi phải xóa mốc neo');
deepEqual(mergeProtagonistDelta(cleared, { age: '30' }), { age: '30' }, 'Sau khi xóa trống rồi điền lại không được khôi phục mốc neo cũ');

// Khi cùng một lá sửa liên tiếp nhiều lần, chỉ giữ lại tuổi cuối cùng và không rò rỉ bất kỳ mốc neo lịch sử nào.
const firstEdit = mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1', outfit: 'Đồng phục trường' }, { age: '24' });
const secondEdit = mergeProtagonistDelta(firstEdit, { age: '25' });
deepEqual(secondEdit, { age: '25', outfit: 'Đồng phục trường' }, 'Chỉnh sửa tuổi lặp lại trên cùng lá phải giữ last-write-wins');

// Hàm gộp không được sửa đổi đối tượng truyền vào, nếu không trạng thái hiện tại của Vue hoặc bản sao lá có thể bị nhiễm bẩn ngoài ý muốn.
const original = { age: '18', ageTime: '2020/1/1' };
mergeProtagonistDelta(original, { age: '25' });
deepEqual(original, { age: '18', ageTime: '2020/1/1' }, 'Gộp không được sửa đối tượng gốc');

// Thao tác thủ công hồ sơ đời sống bắt buộc gộp thực sự vào delta lá; thêm mới liên tiếp trên cùng lá không được ghi đè.
const lifeTarget = {};
equal(
  mergeLifeDetailsOp(lifeTarget, { add: [{ text: 'Không ăn rau mùi' }] }),
  true,
  'Thêm mới hồ sơ đời sống phải báo cáo đã ghi',
);
mergeLifeDetailsOp(lifeTarget, { add: [{ text: 'Quen ngủ sớm' }] });
deepEqual(
  lifeTarget.lifeDetails.add.map(d => d.text),
  ['Không ăn rau mùi', 'Quen ngủ sớm'],
  'Thêm mới liên tiếp trên cùng lá phải giữ lại toàn bộ mục và số thứ tự add của chúng',
);

// Sửa đi sửa lại cùng một mục theo từng trường last-write-wins, đồng thời giữ lại mảng rỗng/chuỗi rỗng làm giá trị xóa tường minh.
mergeLifeDetailsOp(lifeTarget, {
  update: [{ id: 'detail:leaf#0', text: 'Không ăn hành', topics: ['Ăn uống'], until: 'Ngày mai' }],
});
mergeLifeDetailsOp(lifeTarget, {
  update: [{ id: 'detail:leaf#0', anchors: [], until: '', tier: 'pinned' }],
});
deepEqual(
  lifeTarget.lifeDetails.update,
  [{
    id: 'detail:leaf#0',
    text: 'Không ăn hành',
    topics: ['Ăn uống'],
    anchors: [],
    until: '',
    tier: 'pinned',
  }],
  'Chỉnh sửa liên tiếp phải gộp thành bản vá cuối cùng và cho phép xóa nhãn/thời hạn',
);

// Khôi phục/ghim đầu thủ công bắt buộc hủy bỏ archive mà AI đã ghi sớm hơn trong cùng lá, nếu không thứ tự phát lại cố định sẽ lại đánh chìm nó.
const archivedLifeTarget = {
  lifeDetails: { archive: ['detail:old#0', 'detail:other#0'] },
};
mergeLifeDetailsOp(archivedLifeTarget, {
  update: [{ id: 'detail:old#0', tier: 'active' }],
});
deepEqual(
  archivedLifeTarget.lifeDetails.archive,
  ['detail:other#0'],
  'Chuyển tầng thủ công phải ghi đè lệnh archive sớm hơn trong cùng lá',
);

// Xóa chỉ đăng ký id ổn định, không được cắt mảng add làm trôi số thứ tự và id của các mục sau; xóa trùng lặp cần khử trùng lặp.
mergeLifeDetailsOp(lifeTarget, { remove: ['detail:leaf#0'] });
mergeLifeDetailsOp(lifeTarget, { remove: ['detail:leaf#0'] });
equal(lifeTarget.lifeDetails.add.length, 2, 'Xóa không được cắt mảng add vốn dựa vào số thứ tự để sinh id ổn định');
deepEqual(lifeTarget.lifeDetails.remove, ['detail:leaf#0'], 'Xóa trùng lặp phải khử trùng lặp');
equal(mergeLifeDetailsOp({}, {}), false, 'Thao tác hồ sơ đời sống rỗng không được báo thành công giả');

// Cùng lá thêm mới → xóa → thêm lại cùng câu chữ: bắt buộc khôi phục tại chỗ, không được nối thêm rồi bị khử trùng lặp xong lại bị bia mộ cũ xóa mất.
const sameLeafReaddTarget = {
  lifeDetails: {
    add: [{ text: 'Không ăn rau mùi' }, { text: 'Quen ngủ sớm' }],
    remove: ['detail:leaf#0'],
  },
};
mergeLifeDetailsOp(sameLeafReaddTarget, {
  add: [{ text: 'Không ăn rau mùi', topics: ['Ăn uống'] }],
}, {
  leafId: 'leaf',
});
equal(sameLeafReaddTarget.lifeDetails.add.length, 2, 'Thêm lại trên cùng lá không được sinh ra số thứ tự add thứ ba');
deepEqual(
  sameLeafReaddTarget.lifeDetails.add[0],
  { text: 'Không ăn rau mùi', topics: ['Ăn uống'] },
  'Thêm lại trên cùng lá phải khôi phục mục gốc tại chỗ bằng đầu vào mới',
);
equal(sameLeafReaddTarget.lifeDetails.remove, undefined, 'Thêm lại trên cùng lá phải rút lại đánh dấu xóa tương ứng');
equal(
  sameLeafReaddTarget.lifeDetails.update?.some(update => update.id === 'detail:leaf#0') ?? false,
  false,
  'Thêm lại trên cùng lá phải xóa bản vá chỉnh sửa và tầng cấp cũ, khôi phục thành bản ghi mới active',
);

// Mục ở lá sớm hơn bị xóa ở lá hiện tại rồi thêm lại: rút lại xóa, và dùng update đầy đủ ghi đè siêu dữ liệu và tầng cấp cũ.
const crossLeafTarget = {
  lifeDetails: {
    remove: ['detail:old#0'],
    archive: ['detail:old#0'],
  },
};
mergeLifeDetailsOp(crossLeafTarget, {
  add: [{ text: 'Không ăn rau mùi' }],
}, {
  leafId: 'latest',
  existingDetails: [{
    id: 'detail:old#0',
    text: 'Không ăn rau mùi',
    topics: ['Nhãn cũ'],
    anchors: ['Từ khóa cũ'],
    tier: 'pinned',
    until: 'Hôm qua',
    createdAt: 1,
  }],
});
equal(crossLeafTarget.lifeDetails.add, undefined, 'Thêm lại xuyên lá phải khôi phục id ổn định cũ chứ không nối thêm add trùng lặp');
equal(crossLeafTarget.lifeDetails.remove, undefined, 'Thêm lại xuyên lá phải rút lại đánh dấu xóa cũ');
equal(crossLeafTarget.lifeDetails.archive, undefined, 'Thêm lại xuyên lá phải rút lại đánh dấu lưu trữ cũ');
deepEqual(
  crossLeafTarget.lifeDetails.update,
  [{
    id: 'detail:old#0',
    text: 'Không ăn rau mùi',
    topics: [],
    anchors: [],
    until: '',
    tier: 'active',
  }],
  'Thêm lại xuyên lá phải xóa sạch siêu dữ liệu cũ theo đầu vào lần này và khôi phục active',
);

// Tái hiện trực quan lỗi người dùng nhìn thấy: tuổi mới nếu bị áp nhầm mốc neo cũ sẽ lại tăng thêm lần nữa; neo vào thời gian hiện tại mới hiển thị đúng giá trị người dùng nhập.
const { ageDisplay } = await importStandalone('../src/memory/timeRel.ts');
equal(ageDisplay('25', '2020/1/1', '2025/1/1'), 'Khoảng 30 tuổi(năm 2020 là 25 tuổi)', 'Mốc neo cũ sẽ khiến tuổi vừa nhập bị suy tính lần hai');
equal(ageDisplay('25', '2025/1/1', '2025/1/1'), '25', 'Sau khi tuổi mới neo vào thời gian hiện tại phải hiển thị nguyên văn');

const { fmtNpcTiesContext, fmtNpcSummaryList } = await importStandalone('../src/memory/npcRelations.ts');

// Bốn đối tượng mô phỏng Chính yếu/Có mặt/Cùng khu vực/Vắng mặt. Khối quan hệ không nhận phân mức, do đó bắt buộc xuất hiện toàn bộ và mỗi mục một lần.
const allTiers = fmtNpcTiesContext([
  { name: 'Chính yếu Giáp', ties: 'Cha của Ất' },
  { name: 'Có mặt Ất', ties: 'Con của Chính yếu Giáp' },
  { name: 'Gần đó Bính', ties: 'Là kẻ thù truyền kiếp với Đinh' },
  { name: 'Xa xôi Đinh', ties: 'Kẻ thù truyền kiếp của Bính' },
]);
for (const name of ['Chính yếu Giáp', 'Có mặt Ất', 'Gần đó Bính', 'Xa xôi Đinh']) occurrence(allTiers, `  - ${name}:`, 1, `Quan hệ của ${name} phải được tiêm đúng một lần`);

// Trường khoảng trắng không sinh vỏ rỗng; đầu vào nhiều dòng của người dùng bắt buộc phải ép thành một dòng, tránh phá hỏng cấu trúc từ nhắc.
const sparse = fmtNpcTiesContext([
  { name: 'Không quan hệ', ties: '   ' },
  { name: 'Nhiều dòng', ties: 'Cha của Adele\nCó thù cũ với trấn trưởng' },
]);
occurrence(sparse, 'Không quan hệ', 0, 'ties rỗng không được sinh dòng quan hệ');
includes(sparse, '  - Nhiều dòng:Cha của Adele Có thù cũ với trấn trưởng', 'ties nhiều dòng phải ép thành một dòng');

// Nhập dữ liệu bất thường có thể sinh ra mục trùng tên khác hoa thường/khoảng trắng: quan hệ giống nhau khử trùng lặp, quan hệ khác nhau gộp lại và không làm mất.
const duplicateLegacy = fmtNpcTiesContext([
  { name: 'Alice', ties: 'Chị của Bob；Là kẻ thù truyền kiếp với Carol' },
  { name: ' alice ', ties: 'Chị của Bob;Chủ nhân của Dave' },
  { name: 'ALICE', ties: ' Là kẻ thù truyền kiếp với Carol ' },
]);
occurrence(duplicateLegacy, '  - Alice:', 1, 'Dữ liệu cũ trùng tên phải gộp thành một dòng');
occurrence(duplicateLegacy, 'Chị của Bob', 1, 'Quan hệ giao nhau không được lặp lại');
occurrence(duplicateLegacy, 'Là kẻ thù truyền kiếp với Carol', 1, 'Quan hệ trùng lặp xuyên bản ghi không được lặp lại');
occurrence(duplicateLegacy, 'Chủ nhân của Dave', 1, 'Quan hệ riêng có ở phía sau không được bị mất');

equal(fmtNpcTiesContext([]), '', 'Khi không có NPC không được xuất khối quan hệ');
equal(fmtNpcTiesContext([{ name: 'Giáp', ties: undefined }]), '', 'Khi hoàn toàn không có ties không được xuất khối quan hệ');

// Trạng thái cũ mà mô hình tóm tắt nhìn thấy bắt buộc phải bao gồm đồng thời hai loại quan hệ, và nội dung nhiều dòng của người dùng chỉ được chiếm một bản ghi NPC.
const summaryNpc = fmtNpcSummaryList([{
  name: 'Adele',
  gender: 'Nữ',
  age: '30',
  ageTime: '2024/1/1',
  relation: 'Đạo sư của nhân vật chính,thái độ nghiêm khắc',
  ties: 'Chị của Bob\nCó thù cũ với Carol',
  title: 'Nhà giả kim',
  important: true,
  follow: true,
  outfit: 'Áo choàng đen',
  condition: 'Cánh tay trái bị thương',
}]);
occurrence(summaryNpc, 'Với nhân vật chính:Đạo sư của nhân vật chính,thái độ nghiêm khắc', 1, 'Đầu vào tóm tắt phải chứa một lần quan hệ với nhân vật chính');
occurrence(summaryNpc, 'Nhân tế:Chị của Bob Có thù cũ với Carol', 1, 'Đầu vào tóm tắt phải chứa một lần quan hệ dài hạn');
occurrence(summaryNpc, '  - ★ Adele', 1, 'Một NPC không được vì hai loại quan hệ mà bị tách thành bản ghi trùng lặp');
equal(fmtNpcSummaryList([]), '  (Không có)', 'Danh sách NPC trống phải giữ định dạng giữ chỗ vốn có');

// recomputeDerived của store.ts từng dùng danh sách trường không chứa age/ageTime để chép hồ sơ nhân vật chính,
// dẫn đến tuổi tính được khi phát lại không bao giờ tới được bản sao phản ứng (UI trống + tiêm thiếu). recomputeDerived
// phụ thuộc ST context khó kiểm thử đơn vị, ở đây làm chốt bảo vệ cấp mã nguồn: vòng lặp chép bắt buộc phải mang theo cặp mốc neo tuổi.
const storeSource = await readFile(new URL('../src/memory/store.ts', import.meta.url), 'utf8');
const protagonistCopy = storeSource.match(/for \(const key of \[([^\]]+)\][^{]*\{\s*memory\.protagonist\[key\]/s);
assert.ok(protagonistCopy, 'Không tìm thấy vòng lặp chép trường nhân vật chính của recomputeDerived');
includes(protagonistCopy[1], "'age'", 'Vòng lặp chép nhân vật chính bắt buộc phải bao gồm age');
includes(protagonistCopy[1], "'ageTime'", 'Vòng lặp chép nhân vật chính bắt buộc phải bao gồm ageTime');

// Khối nhân vật chính phía tiêm bắt buộc phải đọc memory.protagonist (bản sao phản ứng), và dòng tuổi đi qua ageDisplay để suy tính.
const injectSource = await readFile(new URL('../src/memory/inject.ts', import.meta.url), 'utf8');
includes(injectSource, "['Tuổi tác', ageDisplay(protagonist.age, protagonist.ageTime, now)]", 'Khối tiêm nhân vật chính bắt buộc phải bao gồm suy tính tuổi tác');
includes(injectSource, 'fmtProtagonistContext(memory.protagonist', 'Tiêm nhân vật chính bắt buộc phải đọc bản sao phản ứng');

// Cổng thủ công bắt buộc phải kết nối hồ sơ đời sống và thẻ cục diện, đồng thời trả về thất bại khi không nhận diện được bất kỳ thao tác nào, tránh UI đóng âm thầm.
const applySource = await readFile(new URL('../src/memory/apply.ts', import.meta.url), 'utf8');
includes(applySource, 'mergeLifeDetailsOp(d, op.lifeDetails,', 'Ghi lá thủ công bắt buộc phải gộp thao tác hồ sơ đời sống');
includes(applySource, 'if (op.sceneFocus !== undefined)', 'Ghi lá thủ công bắt buộc phải xử lý ghi đè/xóa trống thẻ cục diện');
includes(applySource, 'if (!changed) return false;', 'Khi chưa ghi bất kỳ thao tác nào không được trả về thành công');

const timeTagSource = await readFile(new URL('../src/memory/timeTag.ts', import.meta.url), 'utf8');
includes(timeTagSource, 's = stripBaiBaiImageTags(s);', 'Làm sạch chính văn thống nhất bắt buộc phải lọc thẻ Bách Bảo Hội');

console.log(`memory regression tests passed: ${assertions} assertions`);
