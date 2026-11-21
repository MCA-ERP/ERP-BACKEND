-- Library: categories, publishers, authors and book copies.
CREATE SEQUENCE public.lib_accession_seq START 10001;
CREATE TABLE public.lib_categories (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE, name VARCHAR(80) NOT NULL, shelf VARCHAR(30) NOT NULL DEFAULT '', status VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')), UNIQUE (institution_id, name));
CREATE TABLE public.lib_publishers (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE, name VARCHAR(80) NOT NULL, city VARCHAR(60) NOT NULL DEFAULT '', contact VARCHAR(60) NOT NULL DEFAULT '', status VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')), UNIQUE (institution_id, name));
CREATE TABLE public.lib_authors (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE, name VARCHAR(120) NOT NULL, status VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')), UNIQUE (institution_id, name));
CREATE TABLE public.lib_copies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    book_id UUID NOT NULL REFERENCES public.lib_books(id) ON DELETE CASCADE,
    accession_no VARCHAR(12) NOT NULL DEFAULT nextval('public.lib_accession_seq')::text,
    barcode VARCHAR(20) NOT NULL DEFAULT '',
    shelf VARCHAR(30) NOT NULL DEFAULT '', call_no VARCHAR(40) NOT NULL DEFAULT '',
    status VARCHAR(10) NOT NULL DEFAULT 'Available' CHECK (status IN ('Available', 'Issued')),
    UNIQUE (institution_id, accession_no)
);
ALTER TABLE public.lib_categories ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lib_publishers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lib_authors ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lib_copies ENABLE ROW LEVEL SECURITY;
