'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface ChatPopupState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const ChatPopupContext = createContext<ChatPopupState>({
  isOpen: false,
  open: () => {},
  close: () => {},
  toggle: () => {},
});

export function useChatPopup() {
  return useContext(ChatPopupContext);
}

export function ChatPopupProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  return (
    <ChatPopupContext.Provider value={{ isOpen, open, close, toggle }}>
      {children}
    </ChatPopupContext.Provider>
  );
}
