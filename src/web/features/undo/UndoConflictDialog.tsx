import { useConflictPrompt } from '../../lib/taskUndo.ts';
import { Button, Dialog } from '../../ui/index.ts';

/** 復原 / 重做前發現欄位已被別人改過時詢問（lib/taskUndo.ts askConflict） */
export function UndoConflictDialog() {
  const prompt = useConflictPrompt();
  const verb = prompt?.kind === 'redo' ? '重做' : '復原';
  return (
    <Dialog
      open={prompt != null}
      onClose={() => prompt?.resolve('skip')}
      role="alertdialog"
      title={prompt ? `「${prompt.fieldLabel}」已被別人修改` : ''}
      actions={
        <>
          <Button variant="secondary" onClick={() => prompt?.resolve('skip')} data-autofocus>
            略過這項
          </Button>
          <Button variant="primary" onClick={() => prompt?.resolve('force')}>
            仍要{verb}
          </Button>
        </>
      }
    >
      {prompt && (
        <>
          <p className="m-0">
            這個欄位在你修改之後被別人改過（現在是『{prompt.currentText}』）。仍要{verb}並覆蓋嗎？
          </p>
          {prompt.more > 0 && (
            <p className="undo-conflict-more">另有 {prompt.more} 個欄位也被改過，會一併覆蓋。</p>
          )}
          <p className="undo-conflict-label">
            要{verb}的動作：{prompt.label}
          </p>
        </>
      )}
    </Dialog>
  );
}
