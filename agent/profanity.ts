/** 重级脏话：侮辱家人 / 极端攻击。只拦这一类，轻中级别按用户要求放行 */
const SEVERE: RegExp[] = [
  /操你妈|草泥马|日你妈|肏你妈|你妈死了|你妈死了吗|死全家|全家死光|你妈逼|妈的逼|狗娘养|婊子养/,
  /杀你全家|弄死你|去死吧|你怎么不去死|死妈|你全家都死/,
]

export function hasSevere(text: string): boolean {
  return SEVERE.some(re => re.test(text))
}

/** 命中重级脏话时替换该词（保留句子其余部分），避免整段被毁 */
export function limitProfanity(text: string, replace: string): string {
  let out = text
  let hit = false
  for (const re of SEVERE) {
    out = out.replace(new RegExp(re.source, 'g'), () => { hit = true; return replace })
  }
  if (!hit) return text
  const trimmed = out.replace(/[\s\p{P}]+/gu, '')
  return trimmed ? out.trim() : replace
}
