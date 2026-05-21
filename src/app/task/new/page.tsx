import type { Metadata } from 'next';
import { TaskForm } from '@/components/TaskForm';

export const metadata: Metadata = { title: 'New task' };

export default function NewCronPage() {
  return <TaskForm />;
}
