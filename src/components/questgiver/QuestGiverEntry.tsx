import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/common/Icon'

interface QuestGiverEntryProps {
  totalFinished: number
}

// The cross-link banner to the guided QuestGiver tool, shown atop Discover.
export function QuestGiverEntry({ totalFinished }: QuestGiverEntryProps) {
  const navigate = useNavigate()
  return (
    <button className="qg-entry" type="button" onClick={() => navigate('/questgiver')}>
      <span className="qg-entry-orb">
        <Icon name="explore" fill />
      </span>
      <span className="qg-entry-body">
        <span className="qg-entry-t">
          QuestGiver
          <span className="qg-entry-ai">
            <Icon name="auto_awesome" fill /> Guided
          </span>
        </span>
        <span className="qg-entry-d">
          Not sure what's next? Answer a few quick questions
          {totalFinished > 0 ? ` - weighted by your ${totalFinished} finished books` : ''} and I'll
          match your next listen.
        </span>
      </span>
      <span className="qg-entry-cta">
        Start <Icon name="arrow_forward" />
      </span>
    </button>
  )
}
