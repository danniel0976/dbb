import { redirect } from 'next/navigation'

export default function BinderPage({ params }) {
  redirect(`/library?binder=${params.id}`)
}
