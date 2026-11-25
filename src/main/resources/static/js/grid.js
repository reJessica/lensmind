export const GRID_NAMES = ['左上', '中上', '右上', '左中', '正中', '右中', '左下', '中下', '右下'];

const regions = {
  左上四格: [0, 1, 3, 4], 右上四格: [1, 2, 4, 5],
  左下四格: [3, 4, 6, 7], 右下四格: [4, 5, 7, 8],
  上排三格: [0, 1, 2], 中排三格: [3, 4, 5], 下排三格: [6, 7, 8],
  左列三格: [0, 3, 6], 中列三格: [1, 4, 7], 右列三格: [2, 5, 8],
  全部九格: [0, 1, 2, 3, 4, 5, 6, 7, 8],
};
const aliases = { 上中: '中上', 下中: '中下', 中左: '左中', 中右: '右中', 中间: '正中', 中央: '正中' };
const numeral = '一二三四五六七八九';

export function parseGridCells(input) {
  let value = input.replace(/[\s，、。！？,!?]/g, '')
    .replace(/^(?:请|把|让|将|位于|落在|站在|放在|移到|移动到|站到|放到|放|画面|在|到|设置为|选中|选)+/, '')
    .replace(/(?:位置|区域|里面|以内|内|里|吧)$/, '')
    .replace(/^(左上|右上|左下|右下)(?:角)?$/, '$1格')
    .replace(/角(?=[一四14]?格)/g, '')
    .replace(/(上中|下中|中左|中右|中间|中央)(?=[一1]?格)/g, name => aliases[name])
    .replace(/([四三九一])格/g, (_, digit) => `${numeral.indexOf(digit) + 1}格`)
    .replace(/(?:全|整|全部)9格/g, '全部9格');
  const options = Object.entries(regions).map(([name, cells]) =>
    [name.replace(/([四三九])格/, (_, digit) => `${numeral.indexOf(digit) + 1}格`), cells]);
  for (const [index, name] of GRID_NAMES.entries()) {
    options.push([`${name}1格`, [index]], [`${name}格`, [index]]);
  }
  const cells = new Set();
  while (value) {
    const numeric = /^第?([1-9一二三四五六七八九])格/.exec(value);
    const named = options.find(([name]) => value.startsWith(name));
    if (!numeric && !named) return null;
    if (named) {
      named[1].forEach(cell => cells.add(cell));
      value = value.slice(named[0].length);
    } else {
      const digit = numeric[1];
      cells.add(/[1-9]/.test(digit) ? Number(digit) - 1 : numeral.indexOf(digit));
      value = value.slice(numeric[0].length);
    }
    value = value.replace(/^(?:和|以及|与|加上|加|还有)/, '');
  }
  return cells.size ? [...cells].sort((a, b) => a - b) : null;
}

export function gridLabel(cells) {
  if (cells.length === 1) return `${GRID_NAMES[cells[0]]}一格`;
  const region = Object.entries(regions).find(([, indices]) =>
    cells.length === indices.length && indices.every(cell => cells.includes(cell)));
  return region?.[0] ?? `九宫格 · ${cells.length} 格`;
}

export function cellBounds(cell) {
  return { x: (cell % 3) / 3, y: Math.floor(cell / 3) / 3, width: 1 / 3, height: 1 / 3 };
}

export function intersectionArea(box, region) {
  const width = Math.max(0, Math.min(box.x + box.width, region.x + region.width) - Math.max(box.x, region.x));
  const height = Math.max(0, Math.min(box.y + box.height, region.y + region.height) - Math.max(box.y, region.y));
  return width * height;
}

export function gridPosition(position, cells) {
  const column = Math.min(2, Math.floor(position.x * 3));
  const row = Math.min(2, Math.floor(position.y * 3));
  if (cells.includes(row * 3 + column)) return { inside: true, x: 0, y: 0 };
  const options = cells.map(cell => {
    const area = cellBounds(cell);
    const x = Math.max(area.x + .02, Math.min(area.x + area.width - .02, position.x)) - position.x;
    const y = Math.max(area.y + .02, Math.min(area.y + area.height - .02, position.y)) - position.y;
    return { inside: false, x, y, distance: Math.hypot(x, y) };
  });
  return options.reduce((nearest, option) => option.distance < nearest.distance ? option : nearest);
}
