"""World circuit catalog: name, venue, GPS centroid, length, direction.

Coordinates are circuit locations (Wikipedia / OSM). Start/finish gates are
stored when we have a published timing line; otherwise GPS proposal + Track
tab drag fills them in after the first good session.

This is small on purpose — a few hundred rows of lat/lon, not map tiles.
"""

# Each layout: name, direction (CW/CCW/BOTH), length_m, lat, lon, radius_m
# Optional sf_gate dict.

def L(name, direction, length_m, lat, lon, radius_m=8000, sf_gate=None):
    return {
        "name": name,
        "direction": direction,
        "length_m": length_m,
        "centroid_lat": lat,
        "centroid_lon": lon,
        "match_radius_m": radius_m,
        "sf_gate": sf_gate,
    }


COTA_SF = {
    "a": {"lat": 30.13341487734439, "lon": -97.64236141614872},
    "b": {"lat": 30.133640722575045, "lon": -97.64215518361536},
    "heading": 128.3,
    "lat": 30.1335278,
    "lon": -97.6422583,
    "source": "sro-alkamel-2024",
}

TRACKS = [
    # --- Texas ---
    {"name": "Circuit of the Americas", "venue": "Austin, TX", "layouts": [
        L("Grand Prix", "CCW", 5513, 30.13278, -97.64111, 8000, COTA_SF),
    ]},
    {"name": "Harris Hill Raceway", "venue": "San Marcos, TX", "layouts": [
        L("Full Course", "BOTH", 2930, 29.918892, -97.873258),
    ]},
    {"name": "MSR Houston", "venue": "Angleton, TX", "layouts": [
        L("2.38 CW", "CW", 3830, 29.27811, -95.42244),
        L("2.38 CCW", "CCW", 3830, 29.27811, -95.42244),
    ]},
    {"name": "MSR Cresson", "venue": "Cresson, TX", "layouts": [
        L("1.7 CW", "CW", 2736, 32.523841, -97.616624),
        L("1.7 CCW", "CCW", 2736, 32.523841, -97.616624),
        L("1.3 CCW", "CCW", 2092, 32.523841, -97.616624),
        L("3.1 CCW", "CCW", 4989, 32.523841, -97.616624),
        L("3.1 CW", "CW", 4989, 32.523841, -97.616624),
    ]},
    {"name": "Eagles Canyon Raceway", "venue": "Decatur, TX", "layouts": [
        L("2.7 CW", "CW", 4345, 33.366921, -97.427176),
        L("2.7 CCW", "CCW", 4345, 33.366921, -97.427176),
    ]},
    # --- US road courses ---
    {"name": "Road Atlanta", "venue": "Braselton, GA", "layouts": [L("Full Course", "CW", 4080, 34.1472, -83.8167)]},
    {"name": "Barber Motorsports Park", "venue": "Birmingham, AL", "layouts": [L("Full Course", "CW", 3700, 33.3760, -86.7110)]},
    {"name": "Sebring International Raceway", "venue": "Sebring, FL", "layouts": [L("Full Course", "CW", 5790, 27.4546, -81.3483)]},
    {"name": "Daytona International Speedway", "venue": "Daytona Beach, FL", "layouts": [
        L("Road Course", "CW", 5729, 29.1850, -81.0700),
        L("Oval", "CCW", 4023, 29.1850, -81.0700),
    ]},
    {"name": "NOLA Motorsports Park", "venue": "Avondale, LA", "layouts": [L("Full Course", "CW", 4390, 29.9320, -90.1920)]},
    {"name": "Virginia International Raceway", "venue": "Alton, VA", "layouts": [L("Full Course", "CW", 5270, 36.5600, -79.2050)]},
    {"name": "Road America", "venue": "Elkhart Lake, WI", "layouts": [L("Full Course", "CW", 6515, 43.7970, -87.9900)]},
    {"name": "Watkins Glen International", "venue": "Watkins Glen, NY", "layouts": [L("Grand Prix", "CW", 5552, 42.3369, -76.9272)]},
    {"name": "Lime Rock Park", "venue": "Lakeville, CT", "layouts": [L("Full Course", "CW", 2370, 41.9280, -73.3840)]},
    {"name": "New Hampshire Motor Speedway", "venue": "Loudon, NH", "layouts": [L("Road Course", "CW", 2575, 43.3620, -71.4610)]},
    {"name": "Mid-Ohio Sports Car Course", "venue": "Lexington, OH", "layouts": [L("Full Course", "CW", 3636, 40.6430, -82.6360)]},
    {"name": "Pittsburgh International Race Complex", "venue": "Wampum, PA", "layouts": [L("Full Course", "CW", 4500, 40.7540, -80.2080)]},
    {"name": "NJMP Thunderbolt", "venue": "Millville, NJ", "layouts": [L("Thunderbolt", "CW", 3600, 39.3550, -75.2550)]},
    {"name": "NJMP Lightning", "venue": "Millville, NJ", "layouts": [L("Lightning", "CW", 3100, 39.3600, -75.2620)]},
    {"name": "Summit Point", "venue": "Summit Point, WV", "layouts": [L("Main", "CW", 3200, 39.2340, -77.9680)]},
    {"name": "Laguna Seca", "venue": "Monterey, CA", "layouts": [L("Full Course", "CW", 3602, 36.5843, -121.7533)]},
    {"name": "Sonoma Raceway", "venue": "Sonoma, CA", "layouts": [L("Full Course", "CW", 4050, 38.1610, -122.4550)]},
    {"name": "Thunderhill Raceway Park", "venue": "Willows, CA", "layouts": [
        L("East 3-mile", "CW", 4830, 39.5390, -122.3310),
        L("West 2-mile", "CW", 3220, 39.5390, -122.3310),
        L("5-mile", "CW", 8050, 39.5390, -122.3310),
    ]},
    {"name": "Buttonwillow Raceway Park", "venue": "Buttonwillow, CA", "layouts": [L("Full Course", "CW", 5150, 35.4910, -119.5450)]},
    {"name": "Willow Springs", "venue": "Rosamond, CA", "layouts": [L("Big Willow", "CW", 4023, 34.8750, -118.2640)]},
    {"name": "Autobahn Country Club", "venue": "Joliet, IL", "layouts": [
        L("North", "CW", 3400, 41.7010, -88.2410),
        L("South", "CW", 2300, 41.7010, -88.2410),
        L("Full", "CW", 5700, 41.7010, -88.2410),
    ]},
    {"name": "Gingerman Raceway", "venue": "South Haven, MI", "layouts": [L("Full Course", "CW", 3380, 42.0850, -86.4400)]},
    {"name": "NCM Motorsports Park", "venue": "Bowling Green, KY", "layouts": [L("Full Course", "CW", 5150, 36.9990, -86.3630)]},
    {"name": "Indianapolis Motor Speedway", "venue": "Indianapolis, IN", "layouts": [
        L("Road Course", "CW", 3925, 39.7950, -86.2347),
        L("Oval", "CCW", 4023, 39.7950, -86.2347),
    ]},
    {"name": "Hallett Motor Racing Circuit", "venue": "Hallett, OK", "layouts": [L("Full Course", "CW", 2900, 36.2420, -96.2210)]},
    {"name": "High Plains Raceway", "venue": "Deer Trail, CO", "layouts": [L("Full Course", "CW", 4020, 39.7450, -104.0420)]},
    {"name": "Utah Motorsports Campus", "venue": "Tooele, UT", "layouts": [L("Outer", "CW", 7140, 40.5830, -112.3750)]},
    {"name": "Portland International Raceway", "venue": "Portland, OR", "layouts": [L("Full Course", "CW", 3166, 45.5960, -122.6960)]},
    {"name": "Pacific Raceways", "venue": "Kent, WA", "layouts": [L("Full Course", "CW", 3700, 47.3190, -122.1350)]},
    {"name": "The Ridge Motorsports Park", "venue": "Shelton, WA", "layouts": [L("Full Course", "CW", 4020, 47.2560, -123.0360)]},
    {"name": "Ozarks International Raceway", "venue": "Gravois Mills, MO", "layouts": [L("Full Course", "CW", 6400, 38.2850, -92.8270)]},
    {"name": "Heartland Motorsports Park", "venue": "Topeka, KS", "layouts": [L("Road Course", "CW", 4200, 38.9270, -95.6750)]},
    {"name": "Homestead-Miami Speedway", "venue": "Homestead, FL", "layouts": [L("Road Course", "CW", 3540, 25.4520, -80.4080)]},
    {"name": "St. Petersburg Street Circuit", "venue": "St. Petersburg, FL", "layouts": [L("Street", "CW", 2900, 27.7660, -82.6330)]},
    {"name": "Long Beach Street Circuit", "venue": "Long Beach, CA", "layouts": [L("Street", "CW", 3167, 33.7660, -118.1910)]},
    {"name": "Miami International Autodrome", "venue": "Miami Gardens, FL", "layouts": [L("Grand Prix", "CCW", 5412, 25.9580, -80.2390)]},
    {"name": "Las Vegas Strip Circuit", "venue": "Las Vegas, NV", "layouts": [L("Grand Prix", "CCW", 6201, 36.1147, -115.1730)]},
    # --- Canada ---
    {"name": "Circuit Gilles Villeneuve", "venue": "Montreal, QC", "layouts": [L("Grand Prix", "CW", 4361, 45.5000, -73.5228)]},
    {"name": "Canadian Tire Motorsport Park", "venue": "Bowmanville, ON", "layouts": [L("Full Course", "CW", 3957, 44.0480, -78.6750)]},
    {"name": "Circuit Mont-Tremblant", "venue": "Mont-Tremblant, QC", "layouts": [L("Full Course", "CW", 4260, 46.1870, -74.6100)]},
    {"name": "Calabogie Motorsports Park", "venue": "Calabogie, ON", "layouts": [L("Full Course", "CW", 5100, 45.3070, -76.6110)]},
    # --- Mexico ---
    {"name": "Autodromo Hermanos Rodriguez", "venue": "Mexico City", "layouts": [L("Grand Prix", "CW", 4304, 19.4042, -99.0907)]},
    # --- Europe / F1 / GT ---
    {"name": "Silverstone Circuit", "venue": "Silverstone, UK", "layouts": [L("Grand Prix", "CW", 5891, 52.0786, -1.0169)]},
    {"name": "Spa-Francorchamps", "venue": "Stavelot, Belgium", "layouts": [L("Grand Prix", "CW", 7004, 50.4372, 5.9714)]},
    {"name": "Nurburgring GP", "venue": "Nurburg, Germany", "layouts": [L("Grand Prix", "CW", 5148, 50.3356, 6.9475)]},
    {"name": "Nurburgring Nordschleife", "venue": "Nurburg, Germany", "layouts": [L("Nordschleife", "CW", 20832, 50.3356, 6.9475, 15000)]},
    {"name": "Monza", "venue": "Monza, Italy", "layouts": [L("Grand Prix", "CW", 5793, 45.6156, 9.2811)]},
    {"name": "Imola", "venue": "Imola, Italy", "layouts": [L("Grand Prix", "CCW", 4909, 44.3439, 11.7167)]},
    {"name": "Mugello", "venue": "Scarperia, Italy", "layouts": [L("Grand Prix", "CW", 5245, 43.9975, 11.3719)]},
    {"name": "Circuit de Barcelona-Catalunya", "venue": "Montmelo, Spain", "layouts": [L("Grand Prix", "CW", 4657, 41.5700, 2.2611)]},
    {"name": "Paul Ricard", "venue": "Le Castellet, France", "layouts": [L("Grand Prix", "CW", 5842, 43.2506, 5.7919)]},
    {"name": "Hungaroring", "venue": "Mogyorod, Hungary", "layouts": [L("Grand Prix", "CW", 4381, 47.5789, 19.2486)]},
    {"name": "Red Bull Ring", "venue": "Spielberg, Austria", "layouts": [L("Grand Prix", "CW", 4318, 47.2197, 14.7647)]},
    {"name": "Zandvoort", "venue": "Zandvoort, Netherlands", "layouts": [L("Grand Prix", "CW", 4259, 52.3888, 4.5408)]},
    {"name": "Monaco", "venue": "Monte Carlo", "layouts": [L("Grand Prix", "CW", 3337, 43.7347, 7.4206)]},
    {"name": "Brands Hatch", "venue": "Kent, UK", "layouts": [
        L("GP", "CW", 3908, 51.3569, 0.2631),
        L("Indy", "CW", 1944, 51.3569, 0.2631),
    ]},
    {"name": "Donington Park", "venue": "Leicestershire, UK", "layouts": [L("GP", "CW", 4020, 52.8300, -1.3750)]},
    {"name": "Oulton Park", "venue": "Cheshire, UK", "layouts": [L("International", "CW", 4307, 53.1800, -2.6100)]},
    {"name": "Portimao", "venue": "Portimao, Portugal", "layouts": [L("Grand Prix", "CW", 4653, 37.2300, -8.6280)]},
    {"name": "Estoril", "venue": "Estoril, Portugal", "layouts": [L("Grand Prix", "CW", 4182, 38.7508, -9.3942)]},
    {"name": "Hockenheimring", "venue": "Hockenheim, Germany", "layouts": [L("Grand Prix", "CW", 4574, 49.3278, 8.5658)]},
    {"name": "Sachsenring", "venue": "Hohenstein-Ernstthal, Germany", "layouts": [L("GP", "CW", 3671, 50.7900, 12.6890)]},
    {"name": "Assen", "venue": "Assen, Netherlands", "layouts": [L("GP", "CW", 4542, 52.9617, 6.5233)]},
    {"name": "Le Mans Bugatti", "venue": "Le Mans, France", "layouts": [L("Bugatti", "CW", 4185, 47.9500, 0.2075)]},
    {"name": "Circuit de la Sarthe", "venue": "Le Mans, France", "layouts": [L("24 Hours", "CW", 13626, 47.9500, 0.2075, 12000)]},
    {"name": "Valencia Ricardo Tormo", "venue": "Cheste, Spain", "layouts": [L("GP", "CW", 4005, 39.4850, -0.6300)]},
    {"name": "Jerez", "venue": "Jerez de la Frontera, Spain", "layouts": [L("GP", "CW", 4428, 36.7083, -6.0342)]},
    # --- Asia / Middle East / Oceania / SA ---
    {"name": "Suzuka", "venue": "Suzuka, Japan", "layouts": [L("Grand Prix", "CW", 5807, 34.8431, 136.5406)]},
    {"name": "Fuji Speedway", "venue": "Oyama, Japan", "layouts": [L("Grand Prix", "CW", 4563, 35.3717, 138.9267)]},
    {"name": "Shanghai International Circuit", "venue": "Shanghai, China", "layouts": [L("Grand Prix", "CW", 5451, 31.3389, 121.2197)]},
    {"name": "Marina Bay Street Circuit", "venue": "Singapore", "layouts": [L("Grand Prix", "CCW", 5063, 1.2914, 103.8640)]},
    {"name": "Bahrain International Circuit", "venue": "Sakhir, Bahrain", "layouts": [L("Grand Prix", "CW", 5412, 26.0325, 50.5106)]},
    {"name": "Yas Marina", "venue": "Abu Dhabi, UAE", "layouts": [L("Grand Prix", "CCW", 5281, 24.4672, 54.6031)]},
    {"name": "Jeddah Corniche Circuit", "venue": "Jeddah, Saudi Arabia", "layouts": [L("Grand Prix", "CCW", 6174, 21.6319, 39.1044)]},
    {"name": "Losail International Circuit", "venue": "Lusail, Qatar", "layouts": [L("Grand Prix", "CW", 5419, 25.4900, 51.4542)]},
    {"name": "Albert Park", "venue": "Melbourne, Australia", "layouts": [L("Grand Prix", "CW", 5278, -37.8497, 144.9680)]},
    {"name": "Phillip Island", "venue": "Phillip Island, Australia", "layouts": [L("GP", "CW", 4450, -38.5020, 145.2350)]},
    {"name": "Interlagos", "venue": "Sao Paulo, Brazil", "layouts": [L("Grand Prix", "CCW", 4309, -23.7036, -46.6997)]},
    {"name": "Kyalami", "venue": "Midrand, South Africa", "layouts": [L("Grand Prix", "CW", 4529, -25.9970, 28.0690)]},
]
