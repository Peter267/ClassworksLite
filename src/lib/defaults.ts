import type { Subject } from './types'

export const DEFAULT_SUBJECTS: Subject[] = [
  { name: '语文', order: 0 },
  { name: '数学', order: 1 },
  { name: '英语', order: 2 },
  { name: '物理', order: 3 },
  { name: '化学', order: 4 },
  { name: '生物', order: 5 },
  { name: '政治', order: 6 },
  { name: '历史', order: 7 },
  { name: '地理', order: 8 },
  { name: '其他', order: 9 },
]

/** 首次打开时的学生列表，直接给出可用的示例，降低上手成本 */
export const DEFAULT_STUDENTS: string[] = [
  '陈亦舟',
  '林知微',
  '周叙白',
  '沈照野',
  '苏念安',
  '顾清和',
  '许星野',
  '江迟',
  '温言',
  '裴让',
]

/** 一言卡片的内置句子：不依赖外部接口，离线也能显示 */
export const HITOKOTO_FALLBACK: string[] = [
  '今天多做一道题，明天就少慌一分钟。',
  '把今天的作业写完，是对明天最好的准备。',
  '不积跬步，无以至千里。',
  '书山有路勤为径，学海无涯苦作舟。',
  '你现在的努力，是未来的你在向你道谢。',
  '安静地写，时间会替你记账。',
  '努力的意义，是让自己有更多选择。',
  '志之所趋，无远弗届。',
  '每一次认真，都在悄悄改变结局。',
  '慢一点没关系，别停下就好。',
  '少年应有鸿鹄志，当骑骏马踏平川。',
  '与其焦虑，不如开始。',
  '今天的事今天做完，明天才有余地。',
  '星光不问赶路人，时光不负有心人。',
  '把简单的事做到极致，就是不简单。',
]

/** 一言接口：失败时自动回退到内置句子 */
export const HITOKOTO_ENDPOINT = 'https://v1.hitokoto.cn/?c=i&c=k&encode=json'

export const QUICK_TEXTS = ['课', '题', '例', '变', 'T', 'P']

/** 数值键盘布局，对齐 Classworks 的快捷输入面板 */
export const KEYPAD_ROWS: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['-', '0', '←'],
]

export const DEFAULT_TEMPLATE = {
  version: 1 as const,
  subjects: {},
  actions: ['背单词', '口语打卡', '订正', '预习', '复习'],
}
