import { create } from 'zustand'
import { Modal } from './Modal.js'
import { Button } from './Button.js'
const useConfirmation = create(() => ({
  message: '',
  resolve: null as ((answer: boolean) => void) | null,
}))
export const confirmAction = (message: string) =>
  new Promise<boolean>((resolve) => {
    useConfirmation.getState().resolve?.(false)
    useConfirmation.setState({ message, resolve })
  })
export function ConfirmAction() {
  const { message, resolve } = useConfirmation()
  if (!resolve) {
    return null
  }
  const answer = (value: boolean) => {
    useConfirmation.setState({ message: '', resolve: null })
    resolve(value)
  }
  return (
    <Modal
      title="确认操作"
      onClose={() => answer(false)}
      footer={
        <>
          <Button variant="outlined" autoFocus onClick={() => answer(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            确认
          </Button>
        </>
      }
    >
      {message}
    </Modal>
  )
}
