namespace com.kuok.shipserv;

@path: '/ShipServ'
service ShipServService {

  @requires: 'authenticated-user'
  @open
  action Inbound(
    destination : String,
    path        : String,
    method      : String
  ) returns {
    code    : String;
    message : String;
    data    : {};
  };

  @requires: 'authenticated-user'
  @open
  action Outbound(
    baseentity  : String,
    destination : String,
    path        : String,
    method      : String
  ) returns {
    code    : String;
    message : String;
    data    : {};
  };

}