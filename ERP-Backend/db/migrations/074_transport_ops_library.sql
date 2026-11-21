-- Transport: trips, maintenance, settings, driver alerts, boardings. Library: books.
CREATE SEQUENCE public.tr_trip_seq START 8813;
CREATE TABLE public.tr_trips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code VARCHAR(12) NOT NULL DEFAULT ('TRP-' || nextval('public.tr_trip_seq')),
    route_id UUID NOT NULL REFERENCES public.tr_routes(id) ON DELETE CASCADE,
    ttype VARCHAR(10) NOT NULL CHECK (ttype IN ('Morning', 'Afternoon')),
    trip_on DATE NOT NULL DEFAULT CURRENT_DATE,
    started_at TIME, ended_at TIME,
    arrived JSONB NOT NULL DEFAULT '[]',
    status VARCHAR(10) NOT NULL DEFAULT 'Running' CHECK (status IN ('Running', 'Completed', 'Delayed')),
    UNIQUE (route_id, trip_on, ttype)
);
CREATE TABLE public.tr_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    trip_id UUID NOT NULL REFERENCES public.tr_trips(id) ON DELETE CASCADE,
    stop_id UUID REFERENCES public.tr_stops(id) ON DELETE SET NULL,
    stop_name VARCHAR(100) NOT NULL, families INTEGER NOT NULL DEFAULT 0,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE public.tr_boardings (
    trip_on DATE NOT NULL, ttype VARCHAR(10) NOT NULL,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL CHECK (status IN ('Boarded', 'Boarded, no card', 'Missing at stop', 'Absent, parent told')),
    note VARCHAR(160), at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (trip_on, ttype, student_id)
);
CREATE TABLE public.tr_maintenance (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    vehicle_id UUID NOT NULL REFERENCES public.tr_vehicles(id) ON DELETE CASCADE,
    mtype VARCHAR(16) NOT NULL CHECK (mtype IN ('Service schedule', 'Repairs', 'Insurance')),
    details VARCHAR(200) NOT NULL DEFAULT '', vendor VARCHAR(100) NOT NULL DEFAULT '',
    due_on DATE NOT NULL, cost INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
    status VARCHAR(12) NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'In progress', 'Done'))
);
CREATE TABLE public.tr_settings (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    seats_rule VARCHAR(40) NOT NULL DEFAULT 'As per fitness certificate', standing BOOLEAN NOT NULL DEFAULT FALSE,
    warn_pct INTEGER NOT NULL DEFAULT 90 CHECK (warn_pct BETWEEN 50 AND 100), waitlist BOOLEAN NOT NULL DEFAULT TRUE,
    n_10min BOOLEAN NOT NULL DEFAULT TRUE, n_delay BOOLEAN NOT NULL DEFAULT TRUE, n_board BOOLEAN NOT NULL DEFAULT FALSE, n_speed BOOLEAN NOT NULL DEFAULT TRUE,
    max_trip_min INTEGER NOT NULL DEFAULT 75 CHECK (max_trip_min BETWEEN 10 AND 300), pickup_window VARCHAR(30) NOT NULL DEFAULT '06:20 – 07:40 am',
    female_attendant BOOLEAN NOT NULL DEFAULT TRUE, stop_change VARCHAR(30) NOT NULL DEFAULT 'Parent request + approval'
);
CREATE TABLE public.lib_books (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    book_no VARCHAR(20) NOT NULL, title VARCHAR(200) NOT NULL, author VARCHAR(120) NOT NULL DEFAULT '',
    category VARCHAR(80) NOT NULL DEFAULT '', publisher VARCHAR(80) NOT NULL DEFAULT '',
    copies INTEGER NOT NULL CHECK (copies BETWEEN 0 AND 1000), available INTEGER NOT NULL CHECK (available >= 0),
    UNIQUE (institution_id, book_no), CHECK (available <= copies)
);
ALTER TABLE public.tr_trips ENABLE ROW LEVEL SECURITY; ALTER TABLE public.tr_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tr_boardings ENABLE ROW LEVEL SECURITY; ALTER TABLE public.tr_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tr_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lib_books ENABLE ROW LEVEL SECURITY;
