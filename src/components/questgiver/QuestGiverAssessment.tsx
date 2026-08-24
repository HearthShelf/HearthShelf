import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getAllLibraryItems, libraryKeys } from '@/api/libraries'
import { qgAssess } from '@/api/questgiver'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { useQuestGiverEnabled } from '@/hooks/useQuestGiver'
import {
  qgAssessmentContext,
  type QgAssessment,
  type QgAssessmentTarget,
} from '@/lib/questgiverAssessment'
import { Icon } from '@/components/common/Icon'
import { Modal } from '@/components/common/Modal'

interface QuestGiverAssessmentProps {
  libraryId: string | null | undefined
  target: QgAssessmentTarget
}

const verdictLabels: Record<QgAssessment['verdict'], string> = {
  strong: 'Very likely',
  good: 'Likely',
  mixed: 'Maybe',
  unlikely: 'Probably not',
  unknown: 'Not enough history',
}

export function QuestGiverAssessment({ libraryId, target }: QuestGiverAssessmentProps) {
  const enabled = useQuestGiverEnabled()
  const progressById = useMediaProgress()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [assessment, setAssessment] = useState<QgAssessment | null>(null)
  const { data } = useQuery({
    queryKey: libraryKeys.allItems(libraryId ?? ''),
    queryFn: () => getAllLibraryItems(libraryId as string),
    enabled: enabled && Boolean(libraryId),
    staleTime: 10 * 60 * 1000,
  })

  if (!enabled) return null

  const assess = async () => {
    setOpen(true)
    if (assessment || loading || !data) return
    setLoading(true)
    try {
      const context = qgAssessmentContext(target, data.results ?? [], progressById)
      setAssessment(await qgAssess(context))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button className="pill qg-assess-trigger" onClick={() => void assess()} disabled={!data}>
        <Icon name="auto_awesome" fill /> Would I like this?
      </button>
      {open && (
        <Modal title="QuestGiver's take" onClose={() => setOpen(false)}>
          <div className="qg-assess">
            <div className="qg-assess-target">
              <span>{target.kind === 'series' ? 'Series' : 'Book'}</span>
              <strong>{target.title}</strong>
              {target.author && <small>{target.author}</small>}
            </div>
            {loading || !assessment ? (
              <div className="qg-assess-loading" aria-live="polite">
                <span className="qg-spinner">
                  <span />
                  <span />
                  <span />
                </span>
                Comparing this with your listening history...
              </div>
            ) : (
              <div aria-live="polite">
                <div className={`qg-assess-verdict ${assessment.verdict}`}>
                  <Icon name={assessment.verdict === 'unknown' ? 'help' : 'auto_awesome'} fill />
                  <div>
                    <strong>{verdictLabels[assessment.verdict]}</strong>
                    <span>{assessment.confidence} confidence</span>
                  </div>
                </div>
                <p className="qg-assess-summary">{assessment.summary}</p>
                <ul className="qg-assess-reasons">
                  {assessment.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                {assessment.caution && <p className="qg-assess-caution">{assessment.caution}</p>}
                <div className="qg-assess-engine">
                  <Icon name={assessment.engine === 'ai' ? 'auto_awesome' : 'tune'} />
                  {assessment.engine === 'ai' ? 'Assessed by AI' : 'Matched from your history'}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
