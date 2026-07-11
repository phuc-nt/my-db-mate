import { redirect } from 'next/navigation';

/** Legacy list route — outputs now live in the unified Library. */
export default function Legacy() {
  redirect('/library?type=dashboard');
}
