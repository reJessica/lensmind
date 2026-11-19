// B 成员：这里是可替换的规则解析器。尚未接入 ASR 服务、LLM 或姿态识别。
// 不猜测有歧义的方向，不将数字放大翻译成真实机位运动。
export function parseCommand(text) {
  const value = text.trim().replace(/[，。！？!?,.\s]/g, '');
  if (/停止|别动|停下|急停/.test(value)) return { type: 'STOP' };
  if (/不要|别拍|不拍/.test(value)) return { type: 'CLARIFY', message: '未执行拍摄。需要取消所有当前操作时，请说“停止”。' };
  if (/重拍|重新拍/.test(value)) return { type: 'CAPTURE' };
  if (/拍照|拍一张|拍张|来一张/.test(value) && !/半身|全身|居中|构图/.test(value)) return { type: 'CAPTURE' };
  if (/回初始|回原位|复位/.test(value)) return { type: 'HOME' };
  if (/动作建议|动作指导|姿势|怎么摆/.test(value)) return { type: 'GUIDE' };
  if (/放大|拉近|缩小|拉远/.test(value) && !/相机|镜头|机位/.test(value)) return { type: 'ZOOM', delta: /缩小|拉远/.test(value) ? -.15 : .15 };
  if (/相机|镜头|机位/.test(value)) {
    if (/靠近|远离|前|后|近|远/.test(value)) return { type: 'CLARIFY', message: '前后移动需要真实空间规划，当前仅支持模拟上下左右微调。可说“放大一点”进行数字裁剪。' };
    const directions = [['左', 'LEFT'], ['右', 'RIGHT'], ['上', 'UP'], ['下', 'DOWN']].filter(([word]) => value.includes(word));
    if (directions.length === 1) return { type: 'MOVE', direction: directions[0][1] };
    return { type: 'CLARIFY', message: '请明确一个机位方向，例如“相机向左一点”。' };
  }
  if (/居中|三分|靠左|靠右|半身|全身/.test(value)) {
    if (/左/.test(value) && /右/.test(value)) return { type: 'CLARIFY', message: '人物希望位于画面左侧还是右侧？' };
    return { type: 'COMPOSE', composition: /左/.test(value) ? 'left' : /右/.test(value) ? 'right' : /居中/.test(value) ? 'center' : undefined, framing: /全身/.test(value) ? 'full' : /半身/.test(value) ? 'half' : undefined };
  }
  return { type: 'CLARIFY', message: '请试试“居中半身照”“放大一点”“相机向左一点”或“拍照”。' };
}
