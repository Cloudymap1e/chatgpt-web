declare namespace svelteHTML {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    // Custom on:modal-esc event
    'on:modal-esc'?: (event: any) => any
  }
}
