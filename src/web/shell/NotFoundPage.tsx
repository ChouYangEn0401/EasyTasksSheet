import { useNavigate } from 'react-router';
import { Button, EmptyState } from '../ui/index.ts';

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <EmptyState
      icon="search"
      title="找不到頁面"
      description="網址可能有誤，或頁面已被移除。"
      action={
        <Button variant="primary" onClick={() => navigate('/')}>
          回到總覽
        </Button>
      }
    />
  );
}
