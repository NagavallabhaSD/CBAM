import { createFileRoute } from '@tanstack/react-router'
import { InsightsPage } from '@/features/cbam/insights'

export const Route = createFileRoute('/_authenticated/insights')({
  component: InsightsPage,
})
