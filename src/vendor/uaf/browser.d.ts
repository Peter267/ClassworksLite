export interface UafPdfOptions {
  fontBytes: ArrayBuffer
  fontLightBytes: ArrayBuffer
  fontBoldBytes: ArrayBuffer
  wasmUrl: URL
  theme?: string
}

export interface UafAssignment {
  subject: string
  date: string
  content: string
  tags: string[]
  style?: Record<string, unknown>
}

export function createUafPdf(
  assignments: UafAssignment[],
  options: UafPdfOptions,
): Promise<Uint8Array>

export function validateUafPdf(bytes: Uint8Array): Promise<{
  valid: boolean
  errors: string[]
  payload?: UafAssignment[]
}>

export function extractUafPayload(bytes: Uint8Array): UafAssignment[]

export function extractUafPayloadCsv(bytes: Uint8Array): string

export function createUafPdfFromCsv(csv: string, options: UafPdfOptions): Promise<Uint8Array>
