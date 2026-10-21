/**
 * UAF（Unified Assignment Format）导入导出。
 *
 * 与上游 apps/web/src/utils/uafExport.js 保持一致的校验、预览、导入计划与落盘逻辑，
 * 仅把 dataProvider 换成本项目的 KV 客户端。
 */

import type { BoardData, HomeworkItem, Subject } from './types'
import type { UafAssignment } from '../vendor/uaf/browser'

const LIMITS = {
  subjectMax: 200,
  contentMax: 2000,
  tagMax: 50,
  tagCountMax: 20,
}

const MAX_UAF_PDF_BYTES = 20 * 1024 * 1024
const MAX_UAF_ASSIGNMENTS = 2000
const MAX_UAF_DATES = 366

export class UafExportValidationError extends Error {
  issues: string[]

  constructor(issues: string[]) {
    super(issues.join('；'))
    this.name = 'UafExportValidationError'
    this.issues = issues
  }
}

export interface UafStyleField {
  fontSize: number
  fontWeight: 'light' | 'regular' | 'bold'
}

export type UafStyle = Record<'subject' | 'content' | 'tags', UafStyleField>

export const DEFAULT_ASSIGNMENT_STYLE: UafStyle = {
  subject: { fontSize: 17, fontWeight: 'regular' },
  content: { fontSize: 13.5, fontWeight: 'regular' },
  tags: { fontSize: 9.5, fontWeight: 'regular' },
}

export interface ExportRow {
  id: string
  assignment: UafAssignment
  selected: boolean
  issues: string[]
}

export interface ImportRow {
  id: string
  index: number
  date: string
  assignment: UafAssignment
  targetType: 'homework' | 'custom'
  targetKey: string | null
  conflict: boolean
  action: 'keep' | 'import' | 'overwrite'
}

export interface ImportPlan {
  rows: ImportRow[]
  boards: Map<string, BoardData>
  /** 创建计划时各日期作业板的云端版本，用于执行时的条件写 */
  versions: Map<string, number | null>
}

/** 校验真实存在的日历日期，拒绝 2026-02-31 这类会被 Date 自动进位的值（F18） */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(year, month - 1, day)
  return (
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  )
}

export function normalizeUafDate(value: string): string {
  if (/^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4))
    const month = Number(value.slice(4, 6))
    const day = Number(value.slice(6, 8))
    if (isRealCalendarDate(year, month, day)) {
      return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    }
    throw new UafExportValidationError([`日期 ${value} 不是真实存在的日期`])
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const year = Number(value.slice(0, 4))
    const month = Number(value.slice(5, 7))
    const day = Number(value.slice(8, 10))
    if (isRealCalendarDate(year, month, day)) return value
    throw new UafExportValidationError([`日期 ${value} 不是真实存在的日期`])
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) {
    const datePart = value.slice(0, 10)
    const year = Number(datePart.slice(0, 4))
    const month = Number(datePart.slice(5, 7))
    const day = Number(datePart.slice(8, 10))
    if (isRealCalendarDate(year, month, day)) return datePart
  }
  throw new UafExportValidationError([
    `日期 ${value || '（空）'} 不是有效的 YYYYMMDD 或 YYYY-MM-DD 格式`,
  ])
}

export function toClassworksDate(value: string): string {
  return normalizeUafDate(value).replaceAll('-', '')
}

function normalizeTags(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.map((tag) => String(tag)) : []
}

export function validateUafAssignment(
  assignment: UafAssignment,
  label = assignment.subject || '作业',
): string[] {
  const issues: string[] = []
  if (!assignment.subject) issues.push(`${label}：科目名称不能为空`)
  if (assignment.subject.length > LIMITS.subjectMax) {
    issues.push(`${label}：科目名称超过 ${LIMITS.subjectMax} 个字符`)
  }
  try {
    normalizeUafDate(assignment.date)
  } catch (error) {
    if (error instanceof UafExportValidationError) {
      issues.push(...error.issues.map((issue) => `${label}：${issue}`))
    }
  }
  if (!assignment.content) issues.push(`${label}：正文不能为空`)
  if (assignment.content.length > LIMITS.contentMax) {
    issues.push(`${label}：正文超过 ${LIMITS.contentMax} 个字符`)
  }
  if (assignment.tags.length > LIMITS.tagCountMax) {
    issues.push(`${label}：标签超过 ${LIMITS.tagCountMax} 个`)
  }
  if (assignment.tags.some((tag) => !tag || tag.length > LIMITS.tagMax || tag.includes(';'))) {
    issues.push(`${label}：包含无效标签`)
  }
  return issues
}

interface ExportableItem {
  key: string
  name: string
  type: string
  content: string
  tags?: string[]
  order?: number
}

export function createExportPreview(items: ExportableItem[], dateValue: string): ExportRow[] {
  const date = normalizeUafDate(dateValue)
  return items
    .filter((item) => item && (item.type === 'homework' || item.type === 'custom'))
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .map((item, index) => {
      const assignment: UafAssignment = {
        subject: String(item.name || '').trim(),
        date,
        content: item.content,
        tags: normalizeTags(item.tags),
        style: JSON.parse(JSON.stringify(DEFAULT_ASSIGNMENT_STYLE)),
      }
      const issues = validateUafAssignment(
        assignment,
        assignment.subject || `第 ${index + 1} 张卡片`,
      )
      return {
        id: `${item.key || index}-${index}`,
        assignment,
        selected: issues.length === 0,
        issues,
      }
    })
}

export function itemsFromBoardData(boardData: BoardData, subjects: Subject[] = []): ExportableItem[] {
  const homework = boardData?.homework || {}
  const items: ExportableItem[] = []
  for (const subject of subjects) {
    const card = homework[subject.name]
    if (card?.content?.trim()) {
      items.push({
        key: subject.name,
        name: subject.name,
        type: 'homework',
        content: card.content,
        tags: normalizeTags(card.tags),
        order: subject.order ?? 0,
      })
    }
  }
  for (const [key, card] of Object.entries(homework)) {
    if (key.startsWith('custom-') && card?.content?.trim()) {
      items.push({
        key,
        name: card.name ?? key,
        type: 'custom',
        content: card.content,
        tags: normalizeTags(card.tags),
        order: 9999,
      })
    }
  }
  return items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

async function loadBrowserUaf() {
  return import('../vendor/uaf/browser.js')
}

export async function parseUafPdf(file: File): Promise<UafAssignment[]> {
  if (!file || !file.name?.toLowerCase().endsWith('.pdf')) {
    throw new UafExportValidationError(['请选择 UAF PDF 文件'])
  }
  if (file.size > MAX_UAF_PDF_BYTES) {
    throw new UafExportValidationError(['UAF PDF 不能超过 20MB'])
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { validateUafPdf, extractUafPayload } = await loadBrowserUaf()
  const validation = await validateUafPdf(bytes)
  if (!validation.valid) {
    throw new UafExportValidationError(
      validation.errors.length ? validation.errors : ['文件不是有效的 UAF PDF'],
    )
  }
  return validation.payload ?? (await extractUafPayload(bytes))
}

export async function createImportPlan(
  document: UafAssignment[],
  subjects: Subject[],
  loadBoardData: (date: string) => Promise<{ board: BoardData; updatedAt: number | null }>,
): Promise<ImportPlan> {
  if (document.length > MAX_UAF_ASSIGNMENTS) {
    throw new UafExportValidationError([`单次导入不能超过 ${MAX_UAF_ASSIGNMENTS} 项作业`])
  }
  const subjectNames = new Set(subjects.map((subject) => subject.name))
  const dates = [...new Set(document.map((assignment) => toClassworksDate(assignment.date)))]
  if (dates.length > MAX_UAF_DATES) {
    throw new UafExportValidationError([`单次导入不能超过 ${MAX_UAF_DATES} 个日期`])
  }
  const boards = new Map<string, BoardData>()
  const versions = new Map<string, number | null>()
  for (const date of dates) {
    const loaded = await loadBoardData(date)
    boards.set(date, loaded.board)
    versions.set(date, loaded.updatedAt)
  }

  // 新自定义卡片使用计划内稳定的 key，失败重试不会重复创建
  const planId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const rows = document.map((assignment, index) => {
    const date = toClassworksDate(assignment.date)
    const board = boards.get(date)!
    const isSubject = subjectNames.has(assignment.subject)
    let targetKey: string | null = isSubject ? assignment.subject : null
    if (!isSubject) {
      targetKey =
        Object.keys(board.homework || {}).find(
          (key) =>
            key.startsWith('custom-') && board.homework[key]?.name === assignment.subject,
        ) ?? `custom-uaf-${planId}-${index}`
    }
    const conflict = Boolean(
      isSubject
        ? board.homework?.[targetKey!]?.content?.trim()
        : Object.keys(board.homework || {}).some(
            (key) =>
              key.startsWith('custom-') &&
              key === targetKey &&
              board.homework[key]?.content?.trim(),
          ),
    )
    return {
      id: `uaf-import-${index}`,
      index,
      date,
      assignment: { ...assignment, tags: normalizeTags(assignment.tags) },
      targetType: isSubject ? ('homework' as const) : ('custom' as const),
      targetKey,
      conflict,
      action: conflict ? ('keep' as const) : ('import' as const),
    }
  })
  return { rows, boards, versions }
}

export function findImportPlanIssues(rows: ImportRow[]): string[] {
  const issues: string[] = []
  const activeTargets = new Map<string, string>()
  const activeSubjects = new Map<string, string>()
  for (const row of rows) {
    if (row.action === 'keep') continue
    const key = row.targetKey ? `${row.date}:${row.targetKey}` : null
    if (key && activeTargets.has(key)) {
      issues.push(`${row.date} 的“${row.assignment.subject}”有多条记录指向同一卡片`)
    }
    if (key) activeTargets.set(key, row.id)

    const subjectKey = `${row.date}:${row.assignment.subject}`
    if (activeSubjects.has(subjectKey)) {
      issues.push(`${row.date} 的“${row.assignment.subject}”有多条导入记录`)
    }
    activeSubjects.set(subjectKey, row.id)
  }
  return issues
}

export async function executeImportPlan(
  plan: ImportPlan,
  saveBoardData: (date: string, board: BoardData) => Promise<void>,
) {
  const issues = findImportPlanIssues(plan.rows)
  if (issues.length) throw new UafExportValidationError(issues)

  const changedDates = new Set<string>()
  let imported = 0
  let skipped = 0

  for (const row of plan.rows) {
    if (row.action === 'keep') {
      skipped += 1
      continue
    }
    const board = plan.boards.get(row.date)!
    board.homework ||= {}
    if (row.targetType === 'homework') {
      board.homework[row.assignment.subject] = {
        ...(board.homework[row.assignment.subject] || {}),
        content: row.assignment.content,
        tags: row.assignment.tags,
      } as HomeworkItem
    } else {
      const key = row.targetKey ?? `custom-uaf-${row.date}-${row.index}`
      board.homework[key] = {
        ...board.homework[key],
        name: row.assignment.subject,
        type: 'custom',
        content: row.assignment.content,
        tags: row.assignment.tags,
      }
    }
    imported += 1
    changedDates.add(row.date)
  }

  const savedDates: string[] = []
  const failedDates: { date: string; error: unknown }[] = []
  for (const date of changedDates) {
    try {
      await saveBoardData(date, plan.boards.get(date)!)
      savedDates.push(date)
    } catch (error) {
      failedDates.push({ date, error })
    }
  }
  return { imported, skipped, savedDates, failedDates }
}

async function fetchFont(filename: string) {
  const response = await fetch(new URL(`uaf/${filename}`, `${window.location.origin}${import.meta.env.BASE_URL}`))
  if (!response.ok) throw new Error(`加载字体 ${filename} 失败：${response.status}`)
  return response.arrayBuffer()
}

let fontCache: Promise<[ArrayBuffer, ArrayBuffer, ArrayBuffer]> | null = null

function loadUafFonts() {
  if (!fontCache) {
    fontCache = Promise.all([
      fetchFont('HarmonyOS_Sans_SC_Regular.ttf'),
      fetchFont('HarmonyOS_Sans_SC_Light.ttf'),
      fetchFont('HarmonyOS_Sans_SC_Bold.ttf'),
    ]).catch((error) => {
      fontCache = null
      throw error
    })
  }
  return fontCache
}

export async function buildUafPdfBytes(assignments: UafAssignment[]) {
  if (!assignments.length) throw new UafExportValidationError(['请至少选择一项作业'])
  const issues = assignments.flatMap((assignment) => validateUafAssignment(assignment))
  if (issues.length) throw new UafExportValidationError(issues)
  const { createUafPdf } = await loadBrowserUaf()
  const [fontBytes, fontLightBytes, fontBoldBytes] = await loadUafFonts()
  const wasmUrl = new URL('uaf/hb-subset.wasm', `${window.location.origin}${import.meta.env.BASE_URL}`)
  return createUafPdf(assignments, {
    fontBytes,
    fontLightBytes,
    fontBoldBytes,
    wasmUrl,
    theme: 'classworks-dark',
  })
}

export async function downloadUafAssignments(assignments: UafAssignment[], dateValue: string) {
  const pdfBytes = await buildUafPdfBytes(assignments)
  const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const date = normalizeUafDate(dateValue)
  link.href = url
  link.download = `Classworks-作业-${date}.uaf.pdf`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return link.download
}
