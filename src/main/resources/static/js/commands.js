import { parseGridCells } from './grid.js';
import { CROP_RATIOS } from './crop.js';

const clarify = message => ({ type: 'CLARIFY', message });
const CHINESE_NUMBERS = '一二三四五六七八九';
const HEAD = /^(?:的)?(?:头部|脑袋|头|脸部|脸)/;
const SUBJECT = /^(?:人物|被摄者|人的|人(?=在|位于|站|头))/;
const REQUEST_PREFIX = /^(?:我(?:想要拍的是|想拍的是|要拍的是|需要|想要|希望|想|要)|需要|想要|希望|请你|请|帮我|给我|把|让|将|拍摄|拍|一张|张)+/;
const FRAMING_PREFIX = /^(?:半身|全身)(?:人像)?(?:照片|照)?的?/;
const FRAMING_SUFFIX = /(?:的)?(?:半身|全身)(?:人像)?(?:照片|照)?$/;
const PHOTO_SUFFIX = /的?(?:照片|人像照?|照)$/;
const REFERENCES = /人物(\d+|[一二两三四五六七八九])号?|第(\d+|[一二两三四五六七八九])个人|(\d+|[一二两三四五六七八九])号人物/g;

// Whisper 可能返回繁体；仅归一化项目控制词，保留界面中的原始转写。
export const normalizeCommandText = text => text.replace(/[請攝鏡頭機幫張開來從裡這個縮擴轉動聽語畫構圖體後復儲刪別繼續]/g,
  char => ({ 請: '请', 攝: '摄', 鏡: '镜', 頭: '头', 機: '机', 幫: '帮', 張: '张', 開: '开', 來: '来', 從: '从', 裡: '里', 這: '这', 個: '个', 縮: '缩', 擴: '扩', 轉: '转', 動: '动', 聽: '听', 語: '语', 畫: '画', 構: '构', 圖: '图', 體: '体', 後: '后', 復: '复', 儲: '储', 刪: '删', 別: '别', 繼: '继', 續: '续' })[char] || char);
const normalize = text => normalizeCommandText(text).trim().replace(/[，。！？!?,.\s]/g, '');
const SHUTTER = /^(?:(?:请|现在|开始|帮我|给我|来|准备好(?:了)?|好(?:了)?))*?(?:拍摄|拍照|拍(?:一)?张(?:照片)?|拍吧|开拍)(?:吧|了)?$/;

export function isSpokenShutter(text) {
  const value = normalize(text);
  return SHUTTER.test(value) || /^(?:请|帮我)?(?:重拍|重新拍(?:摄)?|再拍一张(?:照片)?)(?:吧)?$/.test(value);
}

function ratioFromClause(clause) {
  const value = normalize(clause).replace(/[呀啊吧。了]+$/, '')
    .replace(/^(?:我(?:需要|想要|希望|想|要)|请你|请|帮我|给我|把|将|使用|用|拍一张|来一张|拍|画幅|(?:宽高|画面|裁剪)?比例|裁剪框|调整为|调整到|调整成|调到|调为|调成|切换到|切换成|改成|设为|设成|设置为|换成|是)+/, '')
    .replace(/(?:(?:的)?(?:画幅|(?:宽高|画面)?比例|照片|构图))+$/, '');
  if (/^原(?:始)?$/.test(value)) return 'original';
  if (/^正方形$/.test(value)) return '1:1';
  const ratio = value.replace(/[一二三四五六七八九]/g, number => CHINESE_NUMBERS.indexOf(number) + 1)
    .replace(/1十([1-9])/g, '1$1').replace(/十([1-9])/g, '1$1').replace(/[：比]/g, ':');
  return CROP_RATIOS.includes(ratio) ? ratio : null;
}

function parsePlacement(clause) {
  const part = HEAD.test(clause) ? { part: 'head' } : {};
  const location = clause.replace(HEAD, '');
  const cells = parseGridCells(location);
  if (cells) return { ...part, cells };
  if (/格|左上|右上|左下|右下/.test(location)) return null;
  const options = [
    ['left', /左三分|左边|左侧|靠左|左$/],
    ['center', /居中|中间|中央/],
    ['right', /右三分|右边|右侧|靠右|右$/],
  ].filter(([, rule]) => rule.test(location));
  return options.length === 1 ? { ...part, composition: options[0][0] } : null;
}

function parsePeople(value) {
  const references = [...value.matchAll(REFERENCES)];
  if (!references.length) return clarify('请说出画面中的人物编号，例如“人物1放在左三分”。');
  const targets = [];
  for (const [index, reference] of references.entries()) {
    const number = reference[1] ?? reference[2] ?? reference[3];
    const id = /^\d+$/.test(number) ? Number(number) : CHINESE_NUMBERS.indexOf(number === '两' ? '二' : number) + 1;
    const clause = value.slice(reference.index + reference[0].length, references[index + 1]?.index)
      .replace(/(?:并且|然后|再|并)?(?:请)?(?:把|让|将)?$/, '');
    if (!Number.isSafeInteger(id) || id < 1 || targets.some(target => target.id === id)) {
      return clarify('请确认各自的人物编号。');
    }
    if (references.length === 1 && !clause && /选/.test(value.slice(0, reference.index)) && id >= 1) {
      return { type: 'SELECT_PERSON', id };
    }
    const placement = parsePlacement(clause);
    if (!placement) return clarify('请给每位人物一个位置，例如「人物1的头在右下角」或「人物2左下四格」。');
    targets.push({ id, ...placement });
  }
  return { type: 'POSITION_PEOPLE', targets };
}

// 文字输入和浏览器语音转写共用同一套指令。
export function parseCommand(text, { depthMovement = false } = {}) {
  const clauses = text.split(/[，,。；;、]+|(?:再|并且|然后)(?=把|让|用|设|换|改|调)|(?<=画幅|比例)(?=让|把|人物)/)
    .filter(clause => clause.trim());
  const ratioClauses = clauses.map(ratioFromClause);
  const ratios = ratioClauses.filter(Boolean);
  if (ratios.length && new Set(ratios).size !== 1) return clarify('请指定一个画幅比例。');
  if (ratios.length) {
    const rest = clauses.filter((_, index) => !ratioClauses[index]).join('，');
    if (!rest) return { type: 'RATIO', ratio: ratios[0] };
    const command = parseCompositionCommand(rest, depthMovement);
    if (['COMPOSE', 'POSITION_HEAD', 'POSITION_BODY', 'POSITION_PEOPLE', 'POSITION_SELECTED'].includes(command.type)) {
      return { ...command, ratio: ratios[0] };
    }
    return command.type === 'STOP' ? command : clarify('请说清画幅比例和构图要求。');
  }
  return parseCompositionCommand(text, depthMovement);
}

function parseCompositionCommand(text, depthMovement) {
  const value = normalize(text).replace(/[呀啊吧]+$/, '');
  const stopCheck = value.replace(/(?:不要|不必|不用|别|请勿)(?:再)?(?:停止|停下|急停)/g, '');
  if (/停止|别动|停下|急停/.test(stopCheck)) return { type: 'STOP' };
  if (/^(?:我)?(?:已完成|完成了|做好了|好了)(?:继续)?$/.test(value)) return { type: 'GUIDE_DONE' };
  if (/不要|不必|不用|请勿|别拍|不拍|别放|别缩|别移动|别停止|别停下/.test(value)) {
    return clarify('请确认要执行的操作。需要取消当前操作时，请说“停止”。');
  }
  if (/还是|或者|也可以/.test(value)) return clarify('请选定一个操作后再说一次。');
  if (/怎么拍|如何拍/.test(value)) return clarify('你可以说出构图要求，准备好后再说“拍照”。');
  if (/半身/.test(value) && /全身/.test(value) && !/^(?:请)?(?:不限定|不限|取消)半身全身$/.test(value)) {
    return clarify('你想拍半身照还是全身照？');
  }
  const framing = /半身/.test(value) ? 'half' : /全身/.test(value) ? 'full' : undefined;
  const framingOption = framing ? { framing } : {};
  const request = value.replace(REQUEST_PREFIX, '').replace(FRAMING_PREFIX, '').replace(FRAMING_SUFFIX, '').replace(PHOTO_SUFFIX, '');
  if ([...value.matchAll(REFERENCES)].length) {
    const people = parsePeople(request);
    return people.type === 'POSITION_PEOPLE' ? { ...people, ...framingOption } : people;
  }
  if (/^(?:请)?(?:取消|清除)(?:头部|头|脸部)目标$/.test(value)) return { type: 'CLEAR_HEAD_TARGET' };
  const subject = request.replace(SUBJECT, '');
  if (HEAD.test(subject) && /在|放|移|居中|格|角|三分/.test(subject)) {
    const placement = parsePlacement(subject);
    return placement ? { type: 'POSITION_HEAD', ...placement, ...framingOption }
      : clarify('请说清头部目标位置，例如「让人物的头在右下角」。');
  }
  const cells = parseGridCells(subject);
  if (cells) return { type: SUBJECT.test(request) || framing || PHOTO_SUFFIX.test(value) || REQUEST_PREFIX.test(value)
    ? 'POSITION_BODY' : 'POSITION_SELECTED', cells, ...framingOption };
  if (/格/.test(value) && (/[左中右上下][上中下左右一四14]|九宫格/.test(value))) {
    return clarify('请说清九宫格区域，例如「左下四格」或「中上一格」。');
  }
  if (/重拍|重新拍|再拍一张/.test(value)) return { type: 'RETAKE' };
  if (/回初始|回原位|复位|回到原位/.test(value)) return { type: 'HOME' };
  if (/动作建议|动作指导|姿势|怎么摆|教我怎么站|我该怎么站/.test(value)) return { type: 'GUIDE' };
  if (/^(?:请)?(?:不限定|不限|取消)(?:景别|半身全身|取景范围)?$/.test(value)) return { type: 'COMPOSE', framing: 'any' };

  const adjustCamera = /相机|镜头|机位/.test(value);
  const enlarge = /放大/.test(value) || (!adjustCamera && /拉近/.test(value));
  const shrink = /缩小/.test(value) || (!adjustCamera && /拉远/.test(value));
  if (enlarge && shrink) return clarify('你希望放大还是缩小画面？');
  if ((enlarge || shrink) && !/靠近|远离|机位/.test(value)) {
    return { type: 'ZOOM', delta: shrink ? -.15 : .15 };
  }

  if (adjustCamera && depthMovement && /左|右|上|下|升高|抬高|降低|前|后|近|远|退|抬头|仰起|低头|俯/.test(value)) {
    const directions = [
      [/左/, 'LEFT'], [/右/, 'RIGHT'], [/上|升高|抬高/, 'UP'], [/(?<!俯)下|降低/, 'DOWN'],
      [/前|近/, 'FORWARD'], [/后|远|退/, 'BACKWARD'], [/抬头|仰起/, 'PITCH_UP'], [/低头|俯下/, 'PITCH_DOWN'],
    ].filter(([pattern]) => pattern.test(value));
    if (directions.length === 1) return { type: 'MOVE', direction: directions[0][1] };
    return clarify('请明确一个机位方向，例如“镜头抬头一点”。');
  }

  const nearer = /靠近|近一点|向前|往前|前移/.test(value) || (adjustCamera && /拉近/.test(value));
  const farther = /远离|远一点|向后|往后|后移|退后/.test(value) || (adjustCamera && /拉远/.test(value));
  if (nearer || farther) {
    if (!adjustCamera || nearer === farther) return clarify('你希望相机靠近还是远离？');
    return { type: 'CAMERA_DISTANCE', direction: nearer ? 'NEARER' : 'FARTHER' };
  }
  if (adjustCamera && /向[左右上下]|往[左右上下]|[左右上下]移|移动/.test(value)) {
    const directions = [['左', 'LEFT'], ['右', 'RIGHT'], ['上', 'UP'], ['下', 'DOWN']].filter(([word]) => value.includes(word));
    if (directions.length === 1) return { type: 'MOVE', direction: directions[0][1] };
    return clarify('请明确一个机位方向，例如“相机向左一点”。');
  }

  if (/居中|三分|靠左|靠右|半身|全身/.test(value)) {
    const placement = subject.replace(/^(?:位于|站在|放在|放到|在|画面中|画面|中(?=靠))+/, '');
    const compositions = [['left', /^(?:左(?:侧)?三分(?:线)?|靠左|左边)(?:一点)?$/],
      ['right', /^(?:右(?:侧)?三分(?:线)?|靠右|右边)(?:一点)?$/], ['center', /^(?:居中|中间|中央)$/]];
    const composition = compositions.find(([, rule]) => rule.test(placement))?.[0];
    if (composition || (!placement && framing)) return { type: 'COMPOSE', composition, framing };
    return clarify('人物希望放在画面中央、左侧三分线还是右侧三分线？');
  }
  if (SHUTTER.test(value) || /拍照|拍一张|拍张|来一张/.test(value)) return { type: 'CAPTURE' };
  return clarify('请试试“居中的半身照”“放大一点”“相机向左一点”或“拍照”。');
}
export function spokenYawDirection(text) {
  const command = text.trim().replace(/[。！!，,]/g, '').replace(/\s/g, '');
  const match = command.match(/^(?:请)?(?:相机|镜头|机械臂)(?:向|往)?(左|右)(?:转|微转)(?:一点|一下)?$/);
  return match ? (match[1] === '左' ? 'LEFT' : 'RIGHT') : null;
}
