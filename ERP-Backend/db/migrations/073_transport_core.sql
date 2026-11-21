-- Transport: routes, stops, drivers, attendants and student allocation.
ALTER TABLE public.tr_vehicles DROP CONSTRAINT IF EXISTS tr_vehicles_status_check;
ALTER TABLE public.tr_vehicles ALTER COLUMN status TYPE VARCHAR(16);
ALTER TABLE public.tr_vehicles ADD CONSTRAINT tr_vehicles_status_check CHECK (status IN ('Active', 'In maintenance', 'Inactive'));
CREATE TABLE public.tr_routes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name VARCHAR(60) NOT NULL, area VARCHAR(100) NOT NULL DEFAULT '',
    distance_km INTEGER NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
    first_pickup TIME, at_school TIME,
    status VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, name)
);
CREATE TABLE public.tr_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES public.tr_routes(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL, ord INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 60),
    pickup TIME, drop_time TIME,
    status VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (route_id, ord)
);
CREATE TABLE public.tr_drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL, licence_no VARCHAR(30) NOT NULL, licence_until DATE,
    vehicle_id UUID REFERENCES public.tr_vehicles(id) ON DELETE SET NULL,
    mobile VARCHAR(30), police VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (police IN ('Verified', 'Pending')),
    status VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, licence_no)
);
CREATE TABLE public.tr_attendants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL, route_id UUID REFERENCES public.tr_routes(id) ON DELETE SET NULL,
    vehicle_id UUID REFERENCES public.tr_vehicles(id) ON DELETE SET NULL, mobile VARCHAR(30),
    shift VARCHAR(30) NOT NULL DEFAULT 'Morning + afternoon',
    status VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive'))
);
CREATE TABLE public.tr_allocations (
    student_id UUID PRIMARY KEY REFERENCES public.students(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    route_id UUID REFERENCES public.tr_routes(id) ON DELETE SET NULL,
    stop_id UUID REFERENCES public.tr_stops(id) ON DELETE SET NULL,
    from_on DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(18) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Transfer requested'))
);
ALTER TABLE public.tr_routes ENABLE ROW LEVEL SECURITY; ALTER TABLE public.tr_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tr_drivers ENABLE ROW LEVEL SECURITY; ALTER TABLE public.tr_attendants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tr_allocations ENABLE ROW LEVEL SECURITY;
