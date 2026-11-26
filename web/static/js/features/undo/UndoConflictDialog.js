import { createElement, Fragment } from 'preact';
import { useConflictPrompt } from '../../lib/taskUndo.js';
import { Button, Dialog } from '../../ui/index.js';

/** 復原 / 重做前發現欄位已被別人改過時詢問（lib/taskUndo.ts askConflict） */
export function UndoConflictDialog() {
  const prompt = useConflictPrompt();
  const verb = prompt?.kind === 'redo' ? '重做' : '復原';
  return createElement(
    Dialog,
    {
      open: prompt != null,
      onClose: () => prompt?.resolve('skip'),
      role: 'alertdialog',
      title: prompt ? `「${prompt.fieldLabel}」已被別人修改` : '',
      actions: createElement(
        Fragment,
        null,
        createElement(
          Button,
          { variant: 'secondary', onClick: () => prompt?.resolve('skip'), 'data-autofocus': true },
          '略過這項',
        ),
        createElement(Button, { variant: 'primary', onClick: () => prompt?.resolve('force') }, '仍要', verb),
      ),
    },
    prompt &&
      createElement(
        Fragment,
        null,
        createElement(
          'p',
          { className: 'm-0' },
          '這個欄位在你修改之後被別人改過（現在是『',
          prompt.currentText,
          '』）。仍要',
          verb,
          '並覆蓋嗎？',
        ),
        prompt.more > 0 &&
          createElement(
            'p',
            { className: 'undo-conflict-more' },
            '另有 ',
            prompt.more,
            ' 個欄位也被改過，會一併覆蓋。',
          ),
        createElement('p', { className: 'undo-conflict-label' }, '要', verb, '的動作：', prompt.label),
      ),
  );
}
