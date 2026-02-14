import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://dcewhpeomzedhbsiqjmp.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjZXdocGVvbXplZGhic2lxam1wIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDE2NjA2MCwiZXhwIjoyMDg1NzQyMDYwfQ.QKPaV6vjJ768kIZfWzivqqgnVJ6HaMIhiUG_ta2uACg';

export const supabase = createClient(supabaseUrl, supabaseKey);
