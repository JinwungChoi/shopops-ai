-- 채팅 답변에 표시한 장바구니·주문 확인 결과를 새로고침 후에도 다시 그린다.
alter table public.chat_messages
  add column cart_response jsonb check (cart_response is null or role = 'assistant');
