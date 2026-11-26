import { createElement, Fragment } from 'preact';
import { useNavigate } from '../lib/router.js';
import { Button, EmptyState } from '../ui/index.js';

export function NotFoundPage() {
  const navigate = useNavigate();
  return createElement(EmptyState, {
    icon: 'search',
    title: '找不到頁面',
    description: '網址可能有誤，或頁面已被移除。',
    action: createElement(Button, { variant: 'primary', onClick: () => navigate('/') }, '回到總覽'),
  });
}
