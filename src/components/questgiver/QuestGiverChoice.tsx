import { Icon } from '@/components/common/Icon'

interface QuestGiverChoiceProps {
  icon: string
  title: string
  desc: string
  on: boolean
  onClick: () => void
  tag?: string
}

// Large radio-style card used for the basis + direction steps.
export function QuestGiverChoice({ icon, title, desc, on, onClick, tag }: QuestGiverChoiceProps) {
  return (
    <button className={'qg-choice' + (on ? ' on' : '')} onClick={onClick} type="button">
      <span className="qg-choice-ico">
        <Icon name={icon} fill={on} />
      </span>
      <span className="qg-choice-body">
        <span className="qg-choice-t">
          {title}
          {tag && <span className="qg-choice-tag">{tag}</span>}
        </span>
        <span className="qg-choice-d">{desc}</span>
      </span>
      <span className="qg-choice-check">
        <Icon name={on ? 'radio_button_checked' : 'radio_button_unchecked'} fill={on} />
      </span>
    </button>
  )
}
